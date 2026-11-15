# 会话接口

本页列出创建、读取和修改会话的 REST 接口，以及会话动作、消息与转录、提示词和交互接口。WebSocket 一侧见[会话与对话](./server-api-conversation.md)；鉴权、响应信封、错误码和分页等通用约定见[服务 API](./server-api.md)。

## 会话

这些端点用于创建、列出和查看会话，执行会话级动作（fork、compact、undo 等），并读取会话级汇总。其中大多数返回的会话采用 [session 对象](#session-对象) 中统一说明的线上格式；非 CRUD 操作使用[动作路径约定](./server-api.md#动作路径)。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions` | 创建会话（需 `workspace_id` 或 `metadata.cwd`） |
| `GET /api/v1/sessions` | 列出会话，游标分页，支持 `busy` / `archived_only` 等过滤 |
| `GET /api/v1/sessions/{session_id}` | 读取单个会话 |
| `GET /api/v1/sessions/{session_id}/profile` | 读取会话档案 |
| `POST /api/v1/sessions/{session_id}/profile` | 更新标题、元数据、Agent 配置 |
| `POST /api/v1/sessions/{session_id}/title/generate` | 通过托管的 `chat_title` 工具生成标题 |
| `POST /api/v1/sessions/{session_id}:{action}` | 会话动作：`fork` / `compact` / `undo` / `abort` / `btw` / `archive` / `restore` |
| `GET /api/v1/sessions/{session_id}/children` | 列出子会话 |
| `POST /api/v1/sessions/{session_id}/children` | 创建子会话（fork 并打标） |
| `GET /api/v1/sessions/{session_id}/goal` | 当前目标快照（无则 `null`） |
| `PATCH /api/v1/sessions/{session_id}/goal` | 就地修改当前目标的 objective |
| `GET /api/v1/sessions/{session_id}/warnings` | 会话级告警 |
| `GET /api/v1/sessions/{session_id}/runtime` | 读取 main agent 的运行时绑定 |
| `POST /api/v1/sessions/{session_id}/runtime` | 切换 main agent 的运行时绑定 |
| `POST /api/v1/sessions/{session_id}/export` | 导出会话与诊断信息（zip 流，不走信封） |
| `GET /api/v1/sessions/{session_id}/media/{file_id}` | 按文件 id 下载提示词媒体（二进制） |

### session 对象

每个返回会话的端点都使用这种线上格式。实时状态字段（`busy`、`main_turn_active`、`pending_interaction`、`last_turn_reason`）由会话的活动聚合解析得出：未加载到本服务进程中的会话（冷会话）始终上报为不忙碌且无待处理交互。少数字段在当前投影中是占位值——已逐字段注明。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 会话 id（`session_...`） |
| `workspace_id` | string | 所属工作区 id |
| `title` | string | 会话标题；无标题时为 `""` |
| `created_at` / `updated_at` | string | 创建时间与最后更新时间，ISO 8601 |
| `archived` | boolean | 会话是否已归档（归档后从默认会话列表中隐藏） |
| `archived_at` | string | 归档时间，ISO 8601；仅在已归档时存在 |
| `busy` | boolean | 是否有任一 Agent 存在进行中的轮次或后台任务 |
| `main_turn_active` | boolean | main agent 是否有进行中的轮次 |
| `pending_interaction` | string | `none` / `approval` / `question`——有未答复的交互在等待 |
| `last_turn_reason` | string | main agent 最近一次轮次的结果：`completed` / `cancelled` / `failed` |
| `last_prompt` | string | 最近一条用户提示词文本（如有） |
| `metadata` | object | 自定义元数据；始终携带 `cwd`（会话的工作目录） |
| `agent_config` | object | 投影为 `{ model }`；会话已加载到当前服务端进程、且 main agent 有模型时，`model` 为 main agent 当前的模型（创建响应也是如此，除非创建时没有可用的模型），否则为 `""` |
| `usage` | object | token 汇总 `{ input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, context_tokens, context_limit?, total_cost_usd?, turn_count? }`；目前始终为零。实时上下文大小由 WebSocket 上每个 agent 的 `usage` 帧提供（见 [事件](./server-api-conversation.md#事件)） |
| `permission_rules` | array | 会话权限规则；当前始终为 `[]` |
| `message_count` | integer | 消息数；当前始终为 `0` |

### `POST /api/v1/sessions`

创建会话并返回。目标目录来自 `workspace_id`（已注册的工作区）或 `metadata.cwd`（首次使用时注册该工作区）；两者同时提供时必须一致。创建时会广播全局 `event.session.created` 事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `workspace_id` | body | string | 未提供 `metadata.cwd` 时**必填**。已注册的工作区 id；会话创建于该工作区的根目录 |
| `metadata` | body | object | 自定义元数据。`metadata.cwd` 为工作目录，未提供 `workspace_id` 时**必填**；两者同时提供时必须等于工作区根目录。其他键保存为会话的自定义元数据；保留键 `goal`、`parent_session_id`、`child_session_kind` 会被丢弃 |
| `title` | body | string | 初始标题（至少 1 个字符）；否则会话无标题 |
| `agent_config` | body | object | main agent 的部分配置，字段与 `POST /api/v1/sessions/{session_id}/profile` 相同，另加 `profile`，在返回会话之前应用。无法应用时不创建会话，直接返回错误。`tower_mode: true` 会被拒绝（返回 `40001`）：进入 Tower 模式会改动仓库，创建失败时无法撤销，请在会话建好后通过 `POST /api/v1/sessions/{session_id}/profile` 开启 |

创建会话时就绑定 main agent：`agent_config.profile` 指定 Agent 档案（默认 `agent`），`agent_config.model` 指定模型（默认为服务端当前的默认模型），`agent_config.thinking` 在同一次绑定中按该模型校验。Agent 档案之后不能更改，之后修改默认模型也不影响该会话。没有可用模型时（未配置默认模型或它无法解析），会话照常创建但没有模型；此时如果 `agent_config` 设置了 `profile` 或 `thinking`，则不创建会话。

成功时，`data` 为新会话的 [session 对象](#session-对象)。

- `40001`：`workspace_id` 与 `metadata.cwd` 都未提供，`metadata.cwd` 与工作区根目录不一致，或 `agent_config` 设置了 `tower_mode: true`（`details` 会列出该字段）；`agent_config.model` 未配置、`agent_config.profile` 是未知的 Agent 档案，或模型不支持 `agent_config.thinking` 时也返回此码
- `40113`：没有可用模型，而 `agent_config` 设置了 `profile` 或 `thinking`
- `40409`：工作目录不存在或不是目录
- `40410`：没有以该 `workspace_id` 注册的工作区
- `40913`–`40918`、`40920`：`agent_config` 因目标相关错误无法应用

### `GET /api/v1/sessions`

跨工作区列出会话，按 `updated_at` 最新在前。游标分页遵循 [分页](./server-api.md#分页)，但有一个特例：不提供 `page_size`（且不提供 `archived_only`）时，响应是单个不分页的窗口，其 `has_more` 恒为 `false`，因此要真正翻页请传入 `page_size`。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `before_id` | query | string | 只保留早于该 id 的会话；与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该 id 的会话；与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。分页生效时默认为 `20`；不分页的默认行为见上文说明 |
| `busy` | query | boolean | 只保留忙碌（或只保留空闲）的会话 |
| `include_archive` | query | boolean | 在活跃会话之外同时包含已归档会话。默认 `false` |
| `archived_only` | query | boolean | 只保留已归档会话；与 `include_archive` 互斥；即使不提供 `page_size` 也会启用游标分页 |
| `exclude_empty` | query | boolean | 去掉没有任何用户提示词的会话 |
| `workspace_id` | query | string | 限定到单个工作区（别名会被解析） |

成功时，`data` 为 `{ items, has_more }`，其中每个元素为 [session 对象](#session-对象)。

- `40001`：校验失败——例如 `before_id` 与 `after_id` 同用，或 `archived_only` 与 `include_archive` 同用
- `40410`：未知的 `workspace_id`

### `GET /api/v1/sessions/{session_id}`

从索引中读取单个会话。会话已加载到本进程时会包含实时状态字段；冷会话上报为不忙碌，并携带其最后持久化的轮次结果。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 [session 对象](#session-对象)。

- `40401`：会话不存在，或其工作区已无法解析

### `GET /api/v1/sessions/{session_id}/profile`

读取会话档案——与 `GET /api/v1/sessions/{session_id}` 相同的线上载荷。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 [session 对象](#session-对象)。

- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/profile`

更新会话档案：标题、自定义元数据以及 main agent 的配置。在这里设置的标题会成为自定义标题，优先级高于生成的标题；设置标题会广播全局 `session.meta.updated` 事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `title` | body | string | 新标题（至少 1 个字符）；会成为自定义标题 |
| `metadata` | body | object | 非空时整体替换会话的自定义元数据。保留键 `cwd`、`goal`、`parent_session_id`、`child_session_kind` 会被忽略，会话已存的这些键保持不变 |
| `agent_config` | body | object | main agent 的部分配置；字段如下，均为可选 |

每个 `agent_config` 字段都会立即应用到 main agent：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型别名 id；空字符串会被忽略 |
| `thinking` | string | Thinking 强度等级 |
| `permission_mode` | string | `manual` / `yolo` / `auto` |
| `plan_mode` | boolean | 进入或退出 Plan 模式 |
| `swarm_mode` | boolean | 进入或退出 swarm 模式 |
| `hello_world_mode` | boolean | 进入或退出 hello-world 模式 |
| `goal_objective` | string | 以该文本为内容创建一个目标 |
| `goal_control` | string | `pause` / `resume` / `cancel` 当前目标 |

schema 还接受顶层 `permission_rules` 数组，但更新路由当前不会应用它。

成功时，`data` 为更新后的 [session 对象](#session-对象)。

- `40001`：`model` 未配置、模型不支持 `thinking`，或带了 `agent_config.profile`（Agent 档案只能在创建会话时指定）
- `40113`：会话没有模型时只设置了 `thinking`，没有同时设置 `model`
- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/title/generate`

通过托管供应商的 `chat_title` 工具根据会话的提示词生成标题并应用，同时广播 `session.meta.updated`。生成需要托管 OAuth 登录；未提供 `force` 时，已有自定义标题或已生成标题的会话会上报为不可用，而不会被覆盖。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `force` | body | boolean | 即使已有自定义或生成的标题也重新生成。默认 `false` |
| `source` | body | string | 标题输入：`user_prompts`（默认）/ `first_turn` / `digest` |

成功时，`data` 为 `{ title }`——当前应用到会话的标题。

- `40401`：会话不存在
- `40923`：生成不可用——开关未开启、没有托管 OAuth 登录或尚无任何提示词内容、已有标题但未提供 `force`，或后端请求失败

### `POST /api/v1/sessions/{session_id}:{action}`

会话动作通过同一条路由分发：路径尾部解析为 `{session_id}:{action}`，请求体按该动作的 schema 校验，动作缺失或未知时返回 `40001`（`unsupported action: ...`）。每个动作都会先解析会话，因此会话未知时都可能返回 `40401`。支持的动作在下面逐一说明。

### `POST /api/v1/sessions/{session_id}:fork`

将会话——其转录、Agent 状态与文件——复制到同一工作区中的新会话，并广播 `event.session.created`。源会话会继续运行；如果存在进行中的轮次，fork 会保留该轮次之前最近一个已完成的边界，并将当前轮次的用户 prompt 保存为一个仅含 prompt 的 `cancelled` 轮次，不包含 Assistant 输出、工具活动、排队输入或后续事件。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `title` | body | string | fork 的标题（至少 1 个字符）。默认 `Fork: <source title>` |
| `metadata` | body | object | fork 的自定义元数据 |
| `turn_index` | body | integer | 要保留到的持久化 engine `turnId`（包含该轮次），允许编号空洞。必须是非负安全整数，且该轮次已经完成 |

成功时，`data` 为新会话的 [session 对象](#session-对象)。

- `40001`：`turn_index` 无效、不存在或选中了进行中的轮次
- `40901`：另一项会话历史操作正在进行

### `POST /api/v1/sessions/{session_id}:compact`

对 main agent 的上下文发起一次手动全量压缩。调用立即返回；进度与完成通过 `compaction.*` WebSocket 事件投递。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `instruction` | body | string | 给压缩摘要的额外指引；空值会被忽略 |

成功时，`data` 为空对象。

- `40910`：有轮次或其他上下文变更正在进行，或历史中没有可压缩的内容

### `POST /api/v1/sessions/{session_id}:undo`

将 main agent 的对话回退 `count` 个轮次，并同步修正派生的会话状态（包括会话的 `last_prompt`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `count` | body | integer | 要撤销的轮次数；正整数。默认 `1` |
| `page_size` | body | integer | 返回的历史窗口大小，1–100。默认 `50` |

成功时，`data` 为 `{ messages }`：剩余上下文消息按最新在前的 `{ items, has_more }` 分页。

- `40901`：有轮次正在进行或压缩正在运行——等其结束后重试
- `40911`：无法撤销那么多轮次（遇到压缩边界或检查点丢失）；`data` 携带 `{ reason, requestedCount, undoableCount }`

### `POST /api/v1/sessions/{session_id}:abort`

取消 main agent 正在运行的轮次——等同于用户在 TUI 中中止轮次的程序化版本。

成功时，`data` 为 `{ aborted: true }`。

### `POST /api/v1/sessions/{session_id}:btw`

开启一个 `"by the way"` 旁路对话：把 main agent fork 成一个仅可使用只读工具（`Read`、`Grep`、`Glob`）的子 Agent，让快速的临时问题在隔离环境中运行，不触碰工作上下文。需要可用的模型配置。

成功时，`data` 为 `{ agent_id }`——新子 Agent 的 id。

### `POST /api/v1/sessions/{session_id}:archive`

将会话标记为已归档：它从默认会话列表中消失（使用 `include_archive` 或 `archived_only` 时仍会列出），并且服务端广播全局 `event.session.archived` 事件。

成功时，`data` 为 `{ archived: true }`。

### `POST /api/v1/sessions/{session_id}:restore`

取消会话的归档状态并恢复它。会话原本已归档时，服务端广播全局 `event.session.restored` 事件。

成功时，`data` 为 `archived: false` 的 [session 对象](#session-对象)。

### `POST /api/v1/sessions/{session_id}:reload`

以磁盘上的最新配置重新加载会话：重读 `config.toml` 与插件，重载工作区的 Skill 与 subagent 目录，然后关闭并从磁盘恢复会话。同时会通过系统提醒（system-reminder）把 AGENTS.md、Skill、subagent 及模型的外部变更告知 main agent。

成功时，`data` 为 [session 对象](#session-对象)。

- `40901`：会话有正在运行的轮次，无法重新加载

### `POST /api/v1/sessions/{session_id}:takeover`

移除其他 Kimi Code 进程在该会话上持有的锁，之后可以重试返回 `40931` 的请求。只应在该进程已退出、锁残留时使用：如果它仍在运行，两个进程会同时写入该会话直到它空闲，会话历史可能交错。

成功时，`data` 为 `{ taken_over: true }`。

- `40401`：会话不存在

### `GET /api/v1/sessions/{session_id}/children`

列出会话的子会话——即通过 `POST /api/v1/sessions/{session_id}/children` 创建的会话。游标分页遵循 [分页](./server-api.md#分页)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `before_id` | query | string | 只保留早于该 id 的子会话；与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该 id 的子会话；与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。默认 `100` |
| `busy` | query | boolean | 只保留忙碌（或只保留空闲）的子会话 |

成功时，`data` 为 `{ items, has_more }`，其中每个元素为 [session 对象](#session-对象)。

- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/children`

创建子会话：fork 当前会话并记录为其子会话，因此会出现在 `GET /api/v1/sessions/{session_id}/children` 下。运行中的源会话采用与 `:fork` 相同的已完成轮次边界，以及仅含 prompt 的 `cancelled` 当前轮次；创建子会话不接受历史 `turn_index` 参数。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `title` | body | string | 子会话的标题（至少 1 个字符）。默认 `Child: <source title>` |
| `metadata` | body | object | 子会话的自定义元数据 |

成功时，`data` 为新会话的 [session 对象](#session-对象)，并且服务端广播 `event.session.created`。

- `40901`：另一项会话历史操作正在进行

### `GET /api/v1/sessions/{session_id}/goal`

读取会话当前的目标快照；没有活跃目标时为 `null`。注意，与本 API 的大多数载荷不同，该载荷使用 camelCase 键。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `null` 或 `{ goalId, objective, completionCriterion?, status, turnsUsed, tokensUsed, wallClockMs, budget, terminalReason? }`，其中 `status` 为 `active` / `paused` / `blocked` / `complete`，`budget` 报告 token、轮次与 wall-clock 三项预算，以及各自的剩余量与每项预算的 reached 标志（未设置对应预算时各项为 null）。

- `40401`：会话不存在

### `PATCH /api/v1/sessions/{session_id}/goal`

替换当前目标的 objective，`goalId`、状态、进度和预算均保持不变。适用于 active、paused、blocked 状态的目标。正在运行的 turn 不会被打断，agent 在下一个 turn 收到新的 objective。已连接的客户端通过 `goal.updated` 事件获知变化。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `objective` | body | string | **必填。** 新的 objective，首尾空白会被去除 |

成功时 `data` 是更新后的目标快照，形状与 `GET /api/v1/sessions/{session_id}/goal` 相同（camelCase）。

- `40401`: 会话不存在
- `40914`: 当前没有目标
- `40915`: 目标已完成
- `40917`: objective 为空
- `40918`: objective 超过 4000 字符

### `GET /api/v1/sessions/{session_id}/warnings`

读取会话级告警。目前的产生者只有 `AGENTS.md` 过大检查（`agents-md-oversized`），因此大多数会话的列表为空。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ warnings }`，每个条目为 `{ code, message, severity }`，其中 `severity` 为 `info` / `warning` / `error` 之一。

- `40401`：会话不存在

### `GET /api/v1/sessions/{session_id}/runtime`

读取 main agent 的运行时绑定——即该会话的 Agent 循环运行在哪个运行时上。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ workspace_id, runtime_id }`。

- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/runtime`

切换 main agent 的运行时绑定。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `runtime_id` | body | string | **必填。** 目标运行时 id |

成功时，`data` 为新的绑定 `{ workspace_id, runtime_id }`。

- `40420`：不存在该 `runtime_id` 的运行时
- `40926`：运行时存在但不可用

### `POST /api/v1/sessions/{session_id}/export`

将会话连同诊断日志一起导出为 zip 附件（`kimi-session-<id>.zip`）。响应是二进制流，不是 JSON 信封——能力与失败语义见 [二进制与流式端点](./server-api-files.md#二进制与流式端点)。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `web_log` | body | string | 要包含在归档中的客户端日志文本，最多 256 KB UTF-8 |
| `desktop` | body | boolean | 同时包含桌面宿主的日志。默认 `false` |

### `GET /api/v1/sessions/{session_id}/media/{file_id}`

按文件 id 下载提示词媒体文件（会话提示词引用的图片或其他附件）；尚未提交到会话的 id 会回退到暂存的上传中查找。响应为二进制并支持 `Range`（范围请求返回 206）——共享约定见 [二进制与流式端点](./server-api-files.md#二进制与流式端点)；与那里走信封的端点不同，会话或文件不存在时会返回真正的 404 状态码并携带信封体。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `file_id` | path | string | **必填。** 媒体文件 id |

### 会话 cron、环境、文件历史与评分

与同名工具对应的会话级端点；三个 `cron` 端点是 `CronCreate` / `CronList` / `CronDelete` 工具的 REST 对应物。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/cron` | 列出会话已计划的定时任务 |
| `POST /api/v1/sessions/{session_id}/cron` | 为会话计划一个定时任务 |
| `DELETE /api/v1/sessions/{session_id}/cron/{task_id}` | 从会话移除一个定时任务 |
| `GET /api/v1/sessions/{session_id}/environment` | 获取 main agent 的环境绑定 |
| `GET /api/v1/sessions/{session_id}/environments` | 列出会话可用的环境 |
| `GET /api/v1/sessions/{session_id}/file-history/changes` | 列出某一轮次的文件变更（来自轮次级文件历史） |
| `GET /api/v1/sessions/{session_id}/file-history/content` | 某文件在轮次文件历史检查点处捕获的内容 |
| `POST /api/v1/sessions/{session_id}/rating` | 对最近完成的转录轮次评分，或返回已展示的评分及其最终答案 |

`POST /api/v1/client_configs` 不属于会话级：它按名称获取云端控制的客户端配置（例如 `model_switch_confirm`），未注册的名称返回 `{ name, config: null }`。

## 消息与转录

`messages` 端点分页返回 main agent 的扁平化消息历史，`transcript` 端点则提供按 Agent 组织的结构化转录——轮次、交互、附件——即 WebSocket [转录协议](./server-api-conversation.md#转录协议) 实时流式推送的内容。历史分页与补漏用这些端点，实时尾部用 WebSocket 订阅。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/messages` | 消息分页（`before_id` / `after_id` / `role`） |
| `GET /api/v1/sessions/{session_id}/messages/{message_id}` | 读取单条消息 |
| `GET /api/v1/sessions/{session_id}/transcript` | 按轮次分页的转录（需 `agent_id`）；全局状态不分页随响应返回 |
| `GET /api/v1/sessions/{session_id}/transcript/ops` | op 批次补漏（`since_seq`）；`complete: false` 表示需要全量刷新 |
| `GET /api/v1/sessions/{session_id}/transcript/user-messages` | 各轮次起始的用户输入，不分页 |
| `GET /api/v1/sessions/{session_id}/transcript/plan` | ExitPlanMode 计划内容、路径与审阅结果 |

### `GET /api/v1/sessions/{session_id}/messages`

分页返回 main agent 的消息历史——扁平化的上下文转录——最新在前。游标分页遵循 [分页](./server-api.md#分页)；读取历史会在会话为冷态时将其恢复。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `before_id` | query | string | 只保留早于该消息 id 的消息；与 `after_id` 互斥 |
| `after_id` | query | string | 只保留晚于该消息 id 的消息；与 `before_id` 互斥 |
| `page_size` | query | integer | 1–100。默认 `50` |
| `role` | query | string | 只保留单一角色：`user` / `assistant` / `tool` / `system`。过滤在分页切片之后应用，因此过滤后的一页可能少于 `page_size` 条而 `has_more` 仍为 `true`——持续翻页直到 `has_more` 为 `false` |

成功时，`data` 为 `{ items, has_more }`，其中每个元素是消息对象 `{ id, session_id, role, content, created_at, prompt_id?, parent_message_id?, metadata? }`；`content` 是按 [提示词](#提示词) 中说明的线上格式组成的内容块数组（`text`、`tool_use`、`tool_result`、`image`、`video`、`file`、`thinking`）。

- `40001`：校验失败——例如 `before_id` 与 `after_id` 同用
- `40401`：会话不存在

### `GET /api/v1/sessions/{session_id}/messages/{message_id}`

按 id 从同一历史中读取单条消息。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `message_id` | path | string | **必填。** 消息 id |

成功时，`data` 为上文 `GET /api/v1/sessions/{session_id}/messages` 中说明的元素形态的消息对象。

- `40401`：会话不存在
- `40403`：该会话中不存在此 id 的消息

### `GET /api/v1/sessions/{session_id}/transcript`

返回某个 Agent 的结构化转录中的一页：轮次（含其步骤与帧）以及轮次之间的标记。活跃会话从内存存储应答（先回填所请求 Agent 的持久化历史）；冷会话则从持久化的线上记录重建 Agent。这是转录能力的历史半边——实时流式半边是 [转录协议](./server-api-conversation.md#转录协议) 订阅。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | **必填。** 要读取其转录的 Agent；必须是纯文本形式的 agent id（字母、数字、`.`、`_`、`-`——不含路径分隔符） |
| `before_turn` | query | string | 只保留早于该轮次 id 的轮次；与 `after_turn` 互斥 |
| `after_turn` | query | string | 只保留晚于该轮次 id 的轮次；与 `before_turn` 互斥 |
| `page_size` | query | integer | 1–100 个轮次。默认 `20` |

分页单位是轮次：不带游标时返回最新的一页，`has_more` 表示还有更早的轮次。成功时，`data` 为 `{ agent_id, items, has_more, interactions, attachments, agents, pending_interactions, seq? }`——`items` 是本次分页的轮次切片，`interactions` / `attachments` / `agents` / `pending_interactions` 是不分页、随每次响应一起返回的全局 Agent 状态，`seq` 是该 Agent 用于恢复流的 op 批次水位（仅活跃会话）。任务、Agent 的运行状态与设置、上下文用量、目标和待办都不属于转录，分别通过 WebSocket 的 `task`、`agent`、`usage`、`goal`、`todo` 帧到达（见 [事件](./server-api-conversation.md#事件)）。

- `40001`：校验失败——`before_turn` 与 `after_turn` 同用，或 `agent_id` 不是纯文本形式
- `40401`：会话不存在

### `GET /api/v1/sessions/{session_id}/transcript/ops`

从服务端的 op 日志提供点对点的补漏：某个 Agent 的 `seq > since_seq` 的已记录 op 批次，最旧在前。它是 [转录协议](./server-api-conversation.md#转录协议) 中 `transcript_since` 恢复游标的 REST 对应物，共享同一份有界日志，因此适用相同的回退规则。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | **必填。** Agent id（纯文本形式，约束与转录端点相同） |
| `since_seq` | query | integer | **必填。** 调用方已应用的最后一个 op 批次 seq，最小为 `0`；返回其之后的批次 |

成功时，`data` 为 `{ agent_id, batches, latest_seq, complete }`，每个批次为 `{ seq, ops }`。`complete: true` 表示直到 `latest_seq` 的每个批次都在；`complete: false` 表示日志已不再覆盖到 `since_seq`（或会话根本不是活跃状态），调用方必须回退为一次完整的 `GET .../transcript` 刷新。

- `40001`：校验失败
- `40401`：会话不存在

### `GET /api/v1/sessions/{session_id}/transcript/user-messages`

列出会话中每个开启轮次的输入，按 Agent 分组且不分页：真实用户文本、以斜杠命令形式使用的 Skill 与插件命令、以及 cron 提示词——可通过 `origin` 区分——另有仅含附件的提示词，其 `prompt` 投影为空。所列消息引用的附件实体会随响应一起返回（仅元数据，绝不包含字节内容）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | 只读取一个 Agent（纯文本 id）。默认读取所有在册 Agent |

成功时，`data` 为 `{ agents }`，每个条目为 `{ agent_id, messages, attachments }`；消息为 `{ turn_id, ordinal, state, origin, prompt, attachment_ids?, started_at? }`，其中 `state` 为轮次状态（`queued` / `running` / `completed` / `failed` / `cancelled`）。

- `40001`：校验失败——`agent_id` 不是纯文本形式
- `40401`：会话不存在

### `GET /api/v1/sessions/{session_id}/transcript/plan`

按时间线顺序读取某个 Agent 的 `ExitPlanMode` 工具调用的计划信息——计划内容、计划文件路径、提供的选项以及审阅结果。内容投影自第一个可用的事实来源：关联的审批交互（交互式审阅）、实时工具帧的展示（auto 模式），或工具结果的输出文本；每个条目在 `source` 中记录了具体来源。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `agent_id` | query | string | **必填。** Agent id（纯文本形式） |
| `tool_call_id` | query | string | 将读取范围限定到单次 `ExitPlanMode` 调用；不提供时列出所有可恢复计划内容的调用 |

成功时，`data` 为 `{ agent_id, plans }`，每个计划为 `{ tool_call_id, turn_id, source, plan, path?, options?, review? }`：`source` 为 `interaction` / `display` / `output`，`options` 是审阅选项，形如 `{ label, description? }`，`review`（仅交互式审阅时存在）为 `{ state, selected_option?, feedback? }`，其中 `state` 为 `pending` / `approved` / `rejected` / `cancelled` 之一。

- `40001`：校验失败
- `40401`：会话不存在
- `40416`：提供了 `tool_call_id`，但不存在该 id 的 `ExitPlanMode` 调用

## 提示词

提示词是一次用户输入的单位：提交一条提示词会把它排入会话的 main agent（或指定 Agent）的队列，排队中的提示词可以插入进行中的轮次，运行中的提示词可以中止。轮次进度本身通过 WebSocket [事件](./server-api-conversation.md#事件) 流式推送，不经过这些端点。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/sessions/{session_id}/prompts` | 进行中与排队中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts` | 提交提示词（内容块数组，可带模型 / 权限模式覆盖） |
| `POST /api/v1/sessions/{session_id}/steer` | 直接把消息内容插入进行中的轮次 |
| `POST /api/v1/sessions/{session_id}/prompts:steer` | 把排队的提示词插入进行中的轮次 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort` | 中止运行中的提示词 |
| `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer` | 插入单条排队的提示词 |

### `GET /api/v1/sessions/{session_id}/prompts`

读取 main agent 的提示词队列快照。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |

成功时，`data` 为 `{ active, queued }`：`active` 是运行中的提示词（空闲时为 `null`），`queued` 按顺序列出等待中的提示词。提示词为 `{ prompt_id, user_message_id, status, content, created_at }`，其中 `status` 为 `running` / `queued` / `blocked` 之一，`content` 采用 `POST /api/v1/sessions/{session_id}/prompts` 接受的内容块格式。

- `40401`：会话不存在

### `POST /api/v1/sessions/{session_id}/prompts`

向会话提交一条用户提示词。先校验媒体引用，然后把可选的覆盖项应用到目标 Agent——`model`、`thinking`、`permission_mode` 和 `disabled_tools`——随后提示词入队；响应在提示词被接受后立即返回，不等待轮次执行。提供 `skills` 时，提示词以打包的 Skill 激活方式运行，而不是普通用户提示词。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `content` | body | array | **必填。** 非空的内容块数组；变体见下 |
| `agent_id` | body | string | 目标 Agent。默认为 main agent |
| `prompt_id` | body | string | 客户端选定的提示词 id，用于幂等提交；已被进行中提示词占用的 id 返回 `40927`，已完成的返回 `40903`。不能与 `skills` 同用 |
| `skills` | body | array | 打包的 Skill 激活，至少 1 个 `{ name, path?, args? }` 条目；每个 Skill 必须存在且可由用户激活。`path` 用于选择会话目录中的同名变体 |
| `model` | body | string | 要切换到的模型别名 |
| `thinking` | body | string | Thinking 强度等级 |
| `permission_mode` | body | string | `manual` / `yolo` / `auto` |
| `disabled_tools` | body | array | 要为会话禁用的工具名 |

schema 还接受 `metadata`、`plan_mode`、`swarm_mode`、`goal_objective` 和 `goal_control`，但提交路由当前不会应用它们。每个 `content` 内容块是按 `type` 区分的对象：

| 内容块 | 字段 | 说明 |
| --- | --- | --- |
| `text` | `text` | 纯文本 |
| `image` / `video` | `source` | 媒体输入；`source` 为 `{ kind: "url", url, id? }`、`{ kind: "base64", media_type, data }`、`{ kind: "file", file_id }`（来自 `POST /api/v1/files` 的上传）或 `{ kind: "session_media", file_id }`（已提交到本会话的媒体）之一 |
| `file` | `file_id`、`name`、`media_type`、`size` | 通过 `POST /api/v1/files` 上传的文件附件 |

schema 还接受共享消息格式中的 `tool_use`、`tool_result` 和 `thinking` 内容块，但它们在用户提示词中没有意义。未知或 kind 不匹配的 `file_id` 引用会在提示词创建之前、任何覆盖项应用之前被拒绝。

成功时，`data` 为被接受的提示词 `{ prompt_id, user_message_id, status, content, created_at }`。

- `40001`：校验失败——例如 `prompt_id` 与 `skills` 同用、未知的 `model`、模型不支持的 `thinking` 强度，或带了 `profile` 字段（Agent 档案只能在创建会话时指定）
- `40110`：尚未配置供应商——请先完成登录
- `40111`：解析出的供应商没有凭据（`details.provider_id`）
- `40112`：供应商的凭据被拒绝（`details.provider_id`）
- `40113`：模型无法解析（已知时带 `details.model_id` / `details.provider_id`），或会话没有模型时只设置了 `thinking`、没有同时设置 `model`
- `40401`：会话不存在
- `40407`：引用的 `file_id` 不存在（或与内容块的媒体 kind 不匹配）
- `40415`：某个 `skills` 条目指向未知的 Skill
- `40903`：`prompt_id` 属于已完成的提示词；`data` 携带 `{ aborted: false }`
- `40912`：Skill 存在但无法由用户激活
- `40927`：`prompt_id` 已被进行中的提示词占用

### `POST /api/v1/sessions/{session_id}/steer`

直接把消息内容插入进行中的轮次，只需一次请求，无需先提交再按 id steer。请求体字段与 `POST /api/v1/sessions/{session_id}/prompts` 相同，包括 `content`、`agent_id`、`prompt_id`、`skills`、`model`、`thinking`、`permission_mode` 和 `disabled_tools`。媒体引用与打包 Skill 也复用提示词提交的校验和准备流程。

成功时，`data` 与 `POST /api/v1/sessions/{session_id}/prompts` 返回的被接受提示词结构相同。错误也与提示词提交一致，包括校验、媒体、环境和幂等错误。

### `POST /api/v1/sessions/{session_id}/prompts:steer`

把排队的提示词插入进行中的轮次，让运行中的轮次立即消费它们，而不是先运行结束。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `prompt_ids` | body | array | **必填。** 非空的排队提示词 id 数组 |

成功时，`data` 为 `{ steered: true, prompt_ids }`。

- `40001`：校验失败
- `40401`：会话不存在
- `40402`：所列提示词 id 不在队列中

### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:abort`

中止运行中的提示词。本端点与下面的 `:steer` 通过同一条路由 `POST /api/v1/sessions/{session_id}/prompts/{tail}` 分发：尾部解析为 `{prompt_id}:{action}`，动作缺失或未知时返回 `40001`（`unsupported action: ...`）。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `prompt_id` | path | string | **必填。** 提示词 id |

成功时，`data` 为 `{ aborted: true }`。

- `40401`：会话不存在
- `40402`：不存在该 id 的提示词
- `40903`：提示词已完成；`data` 携带 `{ aborted: false }`

### `POST /api/v1/sessions/{session_id}/prompts/{prompt_id}:steer`

把单条排队的提示词插入进行中的轮次——是 `POST /api/v1/sessions/{session_id}/prompts:steer` 的单提示词形式。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `prompt_id` | path | string | **必填。** 排队中的提示词 id |

成功时，`data` 为 `{ steered: true, prompt_ids: [prompt_id] }`。

- `40401`：会话不存在
- `40402`：没有该 id 的排队提示词

## 审批与提问

审批与提问是会话的两类待处理交互：审批是为工具调用请求许可，提问是请求带标签选项的结构化输入。WebSocket 上的每次变化都以 `interaction` 事件到达（见[事件](./server-api-conversation.md#事件)），回应两类交互共用一个端点。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` | 回应审批或提问 |

### `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`

回应一个待处理的审批或提问。请求体的 `kind` 必须与交互的类型一致；subagent 发起的交互由服务端交回发起它的 agent，因此不需要 `agent_id`。客户端应在收到 `status: "ended"` 的 `interaction` 事件时关闭卡片，而不是依据本接口的响应，这样所有打开该会话的客户端会一起关闭。

| 参数 | 位置 | 类型 | 说明 |
| --- | --- | --- | --- |
| `session_id` | path | string | **必填。** 会话 id |
| `interaction_id` | path | string | **必填。** 事件中的 `interaction_id` |
| `kind` | body | string | **必填。** `approval` / `question` |

`kind: "approval"` 时：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `decision` | string | **必填。** `approved` / `rejected` / `cancelled` |
| `scope` | string | 与 `approved` 同用时，`session`（唯一取值）会在本会话剩余时间内记住该审批规则 |
| `feedback` | string | 交还给 agent 的自由文本反馈 |
| `selected_label` | string | 当请求提供带标签的选项时（例如计划审阅），所选选项的标签 |

`kind: "question"` 时，`answers` 与 `dismissed` 必须且只能传一个：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `answers` | object | 提问条目 id（`q_0`……）到答案对象的映射；变体见下 |
| `dismissed` | `true` | 不回答，直接关闭提问 |
| `method` | string | 答案的产生方式：`enter` / `space` / `number_key` / `click` |
| `note` | string | 附在回答上的自由文本备注 |

每个答案是按 `kind` 区分的对象：

| kind 值 | 字段 | 说明 |
| --- | --- | --- |
| `single` | `option_id` | 选中的单个选项 |
| `multi` | `option_ids` | 选中的多个选项（至少 1 个） |
| `other` | `text` | 自由文本回答 |
| `multi_with_other` | `option_ids`、`other_text` | 选项加自由文本 |
| `skipped` | — | 跳过了该条目 |

成功时，`data` 为 `{ outcome, ended_at }`，审批的 `outcome` 为 `approved` / `rejected` / `cancelled`，提问为 `answered` / `dismissed`。

- `40001`：校验失败（`details` 列出每个字段），或 `kind` 与交互类型不一致
- `40401`：会话不存在
- `40404`：会话中没有该 id 的交互
- `40902`：交互已结束——已被其他客户端回应，或因所在轮次结束、agent 关闭而取消
