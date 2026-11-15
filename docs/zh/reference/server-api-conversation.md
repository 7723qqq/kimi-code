# 会话与对话

本页说明 `/api/v1/ws` 的 WebSocket 协议：建立连接、心跳、控制帧、事件帧、断线恢复和转录协议。会话与消息的 REST 接口见[会话接口](./server-api-sessions.md)；通用约定见[服务 API](./server-api.md)。

## 建立连接

唯一端点是 `ws://<host>:<port>/api/v1/ws`；鉴权在升级请求时完成（见 [鉴权](./server-api.md#鉴权)）。连接建立后服务端立即发送 `server_hello`：

```json
{
  "type": "server_hello",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "payload": {
    "ws_connection_id": "conn_01JZX4...",
    "protocol_version": 2,
    "heartbeat_ms": 10000,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

服务端每 `heartbeat_ms`（默认 10000 毫秒）发送一个 `ping` 帧，客户端必须回以 `pong`。若两个心跳间隔内（约 20 秒）没有收到任何入站帧，服务端会以 `1001` 关闭连接，原因为 `heartbeat timeout`。重连仍由客户端负责。

为了不误断开正常的连接，服务端还做了下面几点处理，客户端不需要配合：

- **不受系统时间影响**：服务端用单调时钟（只会往前走、不受系统时间修改影响的时钟）计时，有人调整系统时间、或者机器睡眠后唤醒，都不会让连接被判为超时。
- **服务端自己卡住之后重新计时**：服务端进程卡住期间发不出 `ping`，客户端也就不会回应。服务端恢复后，如果发现两次检查之间隔了超过 12.5 秒（默认间隔的 1.25 倍），就认为是自己卡住了：不断开连接，而是补发一个 `ping`，重新给客户端 20 秒回应。
- **断开前先读完已到达的消息**：客户端在服务端卡住期间回的 `pong` 可能还没被读取。服务端决定断开之前，会先处理这些已经到达的消息，再检查一次，有回应就不断开。

## 控制帧

客户端发送 JSON 帧 `{ "type", "id"?, "payload" }`；每个请求帧都会收到应答 `{ "type": "ack", "id", "code", "msg", "payload" }`，`code` 为 `0` 表示成功。

| 帧 | payload | 说明 |
| --- | --- | --- |
| `subscribe_v2` | `{ session_id, transcript, transcript_since? }` | 订阅会话（唯一的会话订阅方式）：转录流与交互，`transcript` 按 agent 指定粒度 |
| `unsubscribe_v2` | `{ session_id, agent_ids? }` | 退订转录流；省略 `agent_ids` 或退订最后一个 agent 时取消整个会话订阅 |
| `client_hello` | `{ client_id }` | 握手帧，其余字段会被忽略 |
| `task.watch` | 平铺：`{ request_id, session_id, agent_id, task_id, since_offset?, tail_bytes? }` | 把某个任务的输出流式推送到本连接，无需订阅会话；`agent_id` 是任务所属的 agent（即该任务 `task` 帧上的 `agent_id`），`since_offset` 从客户端已有输出之后续传，`tail_bytes` 是首段输出最多包含的字节数 |
| `task.unwatch` | 平铺：`{ request_id, session_id, agent_id, task_id }` | 停止推送该任务的输出 |
| `task.stop` | 平铺：`{ request_id, session_id, agent_id, task_id }` | 停止任务；已结束的任务直接应答其状态 |
| `task.background` | 平铺：`{ request_id, session_id, agent_id, task_id }` | 让发起任务的工具调用不再等它，任务转入后台继续运行；已在后台或已结束时直接应答其状态，发起方无法不再等它的任务（例如 AgentSwarm 的成员）回复 `40941` |

`task.watch`、`task.unwatch`、`task.stop` 与 `task.background` 是平铺帧：字段与 `type` 并列而不放在 `payload` 下，用 `request_id` 代替 `id`，应答为 `{ "type": "response", "request_id", "code", "msg"?, "task"? }` 而不是 ack；缺少可读的 `request_id` 时服务端以关闭码 1008 断开连接。`task.watch`、`task.stop` 与 `task.background` 成功时，`task` 是任务此刻的状态（形状见下文 `task` 帧，不含 `type`、`session_id`、`agent_id` 与 `event_created_at`）。同一个任务的请求按到达顺序逐个处理，因此在 `task.watch` 尚未应答时发出的 `task.unwatch` 会在它之后生效；不同任务之间、以及它们与其他控制帧之间互不等待。`task.watch` 成功时先应答 `code` 0，再用一个 `task.output` 帧发送最后 `tail_bytes` 字节的输出（默认 32 KiB，最大 1 MiB；`since_offset` 落在这段范围内时只发它之后的部分；没有可发送的输出时 `text` 为空），之后推送实时输出；已结束的任务同样可以 watch。错误：`40001` 帧格式错误（含 `tail_bytes` 超出范围），`40401` 会话不存在，`40406` 该 agent 下没有这个任务，`40941` 该任务不能转入后台（应答仍带任务状态），`50001` 内部错误，`50003` 输出无法读取。

## 事件

事件帧形状为 `{ "type", "seq", "epoch"?, "volatile"?, "offset"?, "session_id"?, "timestamp", "payload" }`，`type` 即事件类型。按投递范围分两类：

- **全局事件**：发送到每个已建立连接，无需订阅——`session.meta.updated`、`event.session.created`、`event.session.archived`、`event.session.restored`、`event.session.work_changed`、`event.session.status_changed`、`event.workspace.*`、`event.config.*`、`event.model_catalog.*`。
- **会话帧**：只发给用 `subscribe_v2` 订阅了该会话的连接——`transcript.reset` / `transcript.ops`（见 [转录协议](#转录协议)）、`task.list`、`task`、`agent`、`usage`、`goal`、`todo` 与 `interaction`。`task.output` 只发给用 `task.watch` 订阅了该任务输出的连接。

| 事件族 | 主要事件 |
| --- | --- |
| 轮次 | `turn.started`、`turn.ended`、`turn.step.started` / `completed` / `interrupted` / `retrying` |
| 流式文本 | `assistant.delta`、`thinking.delta`（带 `offset` 用于对齐） |
| 工具调用 | `tool.call.started`、`tool.call.delta`、`tool.progress`、`tool.result` |
| 交互 | `interaction` |
| subagent | `subagent.spawned` / `started` / `suspended` / `completed` / `failed` / `cancelled` |
| 后台 | `task.started` / `terminated`、`shell.started` / `output` / `completed` |
| 其他 | `compaction.*`、`skill.activated`、`goal.updated`、`prompt.*`、`error`、`warning` |

以下全局生命周期事件可以让跨工作区概览免掉逐工作区轮询。`event.session.archived` 在在线归档与冷归档两条路径上都会发出；其事件帧 `session_id` 是全局水位 `__global__`，真实会话 id 在 payload 里：`{ "type": "event.session.archived", "workspace_id": "wd_...", "sessionId": "session_..." }`（payload 字段为 `workspace_id` / `sessionId`）。已归档的会话被恢复时发出 `event.session.restored`，路径、事件帧和 payload 字段都与 `event.session.archived` 相同。`event.workspace.created` / `updated` 携带完整工作区对象（`{ id, root, name, created_at, last_opened_at, session_count }`——会话创建触碰工作区时也会发 `updated`），`event.workspace.deleted` 携带 `{ "workspace_id", "root" }`。这些事件只覆盖本服务进程内的变更；其他进程（例如写同一 home 目录的 CLI）的变更要等索引 reconcile（约一分钟）才可见，因此概览客户端应保留低频兜底轮询。目前没有会话删除事件。

事件另分持久与易失两种：持久事件带严格递增的 `seq`，落盘并可回放；易失事件（各 `*.delta`、`tool.progress`、`shell.*` 等）标 `volatile: true`，不回放。消费易失文本流时用 `offset`（该轮次内的累计字符偏移）与本地已累积文本比对：小于本地长度说明是重复帧，大于说明有缺漏、需走快照恢复。

Agent 自身的状态由另外四种平铺帧同步，每帧都携带完整的值，客户端整份替换本地副本；和任务帧一样不回放。连接开始接收某个 agent 时（规则同 `task.list`），先收到当前的 `agent`、`usage`（该 agent 有模型上下文时）、`goal`（仅主 agent）与 `todo` 帧，之后每当某个值变化就再收到对应的帧；之后才加入会话的 agent 也会用这几种帧通告自己。订阅会话时如果主 agent 还不存在，服务端会先创建它，所以订阅之后总能收到主 agent 的这几种帧。四种帧都是 `{ type, session_id, agent_id, event_created_at, ... }`：

- `agent`：`{ status: "idle" | "running", model?, thinking?, permission_mode?, plan_mode, swarm_mode, tower_mode }`。`status` 跟随该 agent 的轮次，轮次开始/结束对应的帧在该轮次的 `transcript.ops` 批次之后送达。三个模式字段都是布尔值。
- `usage`：`{ context_tokens, max_context_tokens? }`。只有最新值有意义，因此上下文增长期间服务端每秒最多只发几帧。
- `goal`：`{ goal? }`；会话没有目标时省略 `goal`，有目标是 `{ objective, status: "active" | "paused" | "blocked" | "complete", completion_criterion?, turns_used, tokens_used, wall_clock_ms }`。
- `todo`：`{ items: [{ title, status: "pending" | "in_progress" | "done" }] }`，读自该 agent 的 todo 存储，因此跟随 undo 并在重启后保留。

会话内所有 agent（含 subagent）的审批与提问都以 `interaction` 帧到达。与其他事件不同，它是平铺的——没有 `seq`、`timestamp` 和 `payload` 包装——且从不写入日志、不回放：`{ type: "interaction", session_id, agent_id, event_created_at, interaction_id, kind: "approval" | "question", status: "pending" | "ended", outcome?, ended_at?, tool_call_id?, request, response? }`。审批的 `outcome` 为 `approved` / `rejected` / `cancelled`，提问为 `answered` / `dismissed` / `cancelled`。审批的 `request` 为 `{ tool_name, action, tool_input_display?, expires_at }`，`expires_at` 为发起后 24 小时；提问的为 `{ questions }`，含 1–4 个 `{ id, question, header?, body?, options, multi_select?, allow_other?, other_label?, other_description? }`，每个带 2–4 个 `{ id, label, description? }` 形式的 `options`。服务端会在每次 `client_hello` / `subscribe` / `subscribe_v2` 成功确认后立即补发该会话当前待处理的交互，因此客户端应在收到确认时清空该会话的待处理列表，再用随后到达的帧重建。回应交互使用 [`POST /api/v1/sessions/{session_id}/interactions/{interaction_id}`](./server-api-sessions.md#post-api-v1-sessions-session-id-interactions-interaction-id)。

## 断线恢复

重连后用 `subscribe_v2` 重新订阅，服务端会针对你请求的每个 agent 回一份全新的 `transcript.reset`，本地状态从这份基线重建，而不是按游标回放；全局推送事件在连接建立后即刻恢复。

## 转录协议

`subscribe_v2` 的 `transcript` 按 agent 指定粒度：`off` / `turn` / `block` / `delta`（键 `"*"` 表示默认粒度），粒度越高推送越细。粒度非 `off` 的 agent 走两帧推送：`transcript.reset`（基线快照，历史经 REST 分页回读）和 `transcript.ops`（增量批次，带每个 agent 连续递增的 `seq`）；该 agent 的旧式事件在同一连接上被抑制，改由转录帧承载。断线时用 `transcript_since` 续传；服务端批次日志无法覆盖缺口时（REST 补漏返回 `complete: false`）需全量刷新。REST 侧对应 `GET .../transcript`（按轮次分页）与 `GET .../transcript/ops?since_seq=`（批次补漏）。订阅不会跨断线保留：重连后对每个会话重新发送 `subscribe_v2`，各 agent 的 `task.list`、`agent`、`usage`、`goal` 与 `todo` 帧会重新发送。
