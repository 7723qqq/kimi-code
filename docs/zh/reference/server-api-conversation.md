# 会话与对话

本页说明 `/api/v1/ws`。REST 接口见[会话接口](./server-api-sessions.md)，鉴权与通用约定见[服务 API](./server-api.md)。

## 建立连接

连接 `ws://<host>:<port>/api/v1/ws`，鉴权在升级请求时完成。不需要 `client_hello`，服务端也不会发送 `server_hello`。

服务端默认每 10000 毫秒发送 `ping`，客户端回复 `pong`。连续两个间隔没有入站帧时，以 `1001`（`heartbeat timeout`）关闭连接。任何入站帧均算活动。心跳使用单调时钟；事件循环卡顿超过 1.25 个间隔后重新给予响应窗口，并在断开前处理已排队输入。

## 控制帧

所有请求都是平铺 JSON 对象，字段与 `type` 并列，不放在 `payload` 内：

```json
{"type":"subscribe","request_id":"sub-1","session_id":"session_…","agent_ids":["main"]}
```

应答为 `{ "type": "response", "request_id", "code", "msg"? }`，`code: 0` 表示成功。已识别命令缺少非空 `request_id` 时以 `1008` 关闭连接，字段格式错误返回 `40001`。未知帧类型会被忽略。

| 类型 | type/request_id 以外的字段 | 作用 |
| --- | --- | --- |
| `subscribe` | `session_id, agent_ids?` | 订阅对话投影；没有 transcript 选项时默认 main |
| `unsubscribe` | `session_id, agent_ids?` | 移除指定 agent；省略 agent_ids 时移除整个会话订阅 |
| `subscribe` | `session_id, transcript, transcript_since?` | 订阅下文保留的转录协议 |
| `task.watch` | `session_id, agent_id, task_id, since_offset?, tail_bytes?` | 订阅一个任务的输出 |
| `task.unwatch` | `session_id, agent_id, task_id` | 停止订阅任务输出 |
| `task.stop` | `session_id, agent_id, task_id` | 停止任务 |
| `task.background` | `session_id, agent_id, task_id` | 释放前台调用方，让任务继续运行 |

`subscribe_v2`、`unsubscribe_v2`、嵌套 payload 命令和 `ack` 均不是此协议。每条连接的订阅/退订命令按序执行。成功响应先于初始对话及待处理交互帧发送，因此客户端可以在成功响应时清空待处理交互，再由后续帧重建。

任务应答可能额外包含 `task`。同一任务的命令按序执行。watch 成功后先应答，再发送最后 `tail_bytes` 字节（默认 32 KiB，最大 1 MiB，并受 `since_offset` 限制），随后推送实时 `task.output`。已结束任务仍可 watch。错误包括 `40401`（会话）、`40406`（任务）、`40941`（不能转后台）、`50003`（输出无法读取）。

## 对话投影

对话帧包含 `session_id`、`agent_id`、`event_created_at`。首屏 `turns` 帧包含 `{ turns, has_more }`；更早历史通过 `GET /api/v1/sessions/{session_id}/agents/{agent_id}/turns?before_ordinal=…&page_size=…` 分页读取。

| 帧 | 额外字段 |
| --- | --- |
| `turn.started`、`turn.ended` | `turn` 头部 |
| `turn.updated` | `turn_id, step?, retry?` |
| `item.started`、`item.ended` | `turn_id, item` |
| `item.updated` | `turn_id, item_id, set` |
| `item.delta` | `turn_id, item_id, field, delta`；field 为 text/input_text/output |
| `item.removed` | `turn_id, item_id` |
| `turns.removed` | `turn_ids` |
| `turns.failed` | `code, msg` |
| `notice` | `level, title, detail?, code?` |

把增量应用于指定 item；收到最终 `item.ended` 时替换该条目，不要再次拼接其文本。首屏加载期间到达的实时事件缓冲到首屏之后发送。分页失败发送 `turns.failed` 并释放监听器，退订或关闭连接会使尚未完成的投递失效。

投影来自持久化事件，而不是当前模型上下文。轮次保留已记录的 `turn_number`、时间、步骤和用量；条目保留步骤身份、思考时长、媒体和工具附注。上下文压缩增加系统条目，不删除之前可见的历史。重试按 step ID 清理废弃尝试的正文，即使执行引擎给下一次尝试分配了新步骤编号。clear 与 undo 移除对应历史。没有步骤元数据的旧消息仍可读取，不伪造步骤信息。

工具调用阶段为 `input`、`awaiting_approval`、`executing`。可选的 `interaction_id`、`task_id`、`agent_refs` 来自已记录关联，不从输出文字猜测。进度更新同时包含官方 `fields`（`status`、`statusReplace`、`progress`）和本 fork 的 `progress` 扩展。任务关联在重放后保留。轮次不存在与 agent 不存在使用不同错误码：分别为 `40422`、`40421`。

## Agent、任务与交互帧

服务端还发送全量值平铺帧 `{ type, session_id, agent_id, event_created_at, … }`：

- `agent`：`status: idle|running`、`compacting`，可选 model/thinking/permission_mode，以及布尔 plan_mode/swarm_mode/tower_mode。压缩开始、完成与取消时刷新 compacting。
- `usage`：`context_tokens, max_context_tokens?`，快速更新期间合并推送。
- `goal`：可选 goal，包含 objective、status、completion_criterion、turns_used、tokens_used、wall_clock_ms。
- `todo`：`items: [{title,status}]`。
- `task.list`、`task`：当前任务清单及更新。`task.output` 仅发送给该任务的输出订阅者。

`interaction` 包含 `interaction_id`、`kind: approval|question`、`status: pending|ended`，可选 outcome/ended_at/tool_call_id、`request` 及可选 `response`。成功订阅后补发待处理交互。通过 `POST /api/v1/sessions/{session_id}/interactions/{interaction_id}` 回应。审批结果为 approved/rejected/cancelled，提问结果为 answered/dismissed/cancelled。

全局生命周期事件仍使用 `{type,seq,session_id?,timestamp,payload,…}` 信封，发送给所有连接，涵盖会话元数据/活动、工作区、配置与模型目录更新。对话订阅会抑制相应 agent 的旧轮次信封；不要把旧信封中的 `turn.started` 当成对话轮次头部。

## 断线恢复

订阅不会跨断线保留。重连后重新发送平铺 `subscribe`；每个指定 agent 都收到新的 `turns` 页、agent/任务状态与待处理交互。替换本地基线后应用后续 item 帧。实时投递与冷恢复共用同一持久化对话投影。

## 转录协议

本 fork 为 Operation Log/转录客户端保留带 `transcript` 的 `subscribe`，粒度为 `off|turn|block|delta`（`"*"` 指定默认粒度）。这类客户端接收 `transcript.reset` 与带 agent 内序号的 `transcript.ops`。重连可传 `transcript_since`；操作日志无法覆盖缺口时刷新基线。REST 接口为 `GET …/transcript` 与 `GET …/transcript/ops?since_seq=…`。它与官方对话投影分离，不替代 turn/item 帧。
