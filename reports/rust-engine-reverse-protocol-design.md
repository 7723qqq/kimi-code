# Rust 引擎反向交互协议设计（ask-user-question 前置）

> 状态：**设计草案（待审阅）** — 基于当前代码快照调研，落码前需按第 8 节顺序推进并逐项验收。
> 目标读者：本仓库维护者。本文档是 kimi-agent ROADMAP 第 4 批「协议前置」中反向交互协议的设计蓝图，不是 commit 记录。
> 关联决策：D-2（引擎做完整 runtime，宿主状态与人机交互类工具在目标范围内）。

## 1. 背景与目标

D-2 决策把 ask-user-question / todo / plan / task 族等「依赖宿主状态或人类交互」的工具纳入引擎吸收范围，引擎从「工具移植」升级为「完整 runtime」。其中 ask-user-question 类工具有一个此前不存在的前置条件：**引擎要向宿主发问并等回答，且不阻塞 step 循环**。现有 `HostCallbacks` 只有 engine→host 的单向请求（llm_chat / execute_tool / check_permission / drain_steers）和 fire-and-forget 事件（emit_event），没有「问一个问题、等一个人类回答」的语义。

本文档回答五个问题：

1. 协议消息格式（wire JSON：question id、prompt、options、timeout、取消）
2. napi/stdio 双通道传递方式（新增回调 vs 复用事件通道）
3. 不阻塞 step 循环的机制（异步等待 + 超时 + 取消，与现有 drain_steers 的关系）
4. 状态层归属建议（todo/plan 的持久化 + undo 语义在引擎内的方案）
5. 与现有 HostCallbacks 的集成点（新增 trait 方法还是独立通道）

不在本文档范围：todo/plan 的具体实现（只给归属建议）、子代理递归（第 4 批另一项，另文设计）、第 7 批各工具的吸收细节。

## 2. 现状审计

### 2.1 Rust 侧回调机制（`src/callbacks.rs`）

`HostCallbacks` trait 是引擎→宿主的唯一接缝，现有 7 个方法：

| 方法 | 形状 | 超时 | 取消 |
|---|---|---|---|
| `llm_chat` | 请求/响应 | 900s（`HOST_LLM_TIMEOUT`） | napi 侧观察 cancel flag |
| `execute_tool` | 请求/响应 | 600s（`HOST_TOOL_TIMEOUT`） | 同上 |
| `check_permission` | 请求/响应 | **无**（人在回路） | napi 侧观察 cancel flag；stdio 侧靠宿主 abort handler |
| `finalize_tool_result` | 请求/响应 | 30s | 同上 |
| `drain_steers` | 请求/响应 | 30s | 同上 |
| `emit_event` | fire-and-forget 通知 | — | — |
| `cancel_llm_chat` | fire-and-forget（经 emit_event） | — | — |

两个实现：

- **`RpcHostCallbacks`**（stdio JSON-RPC）：`server.invoke(method, params, timeout)` — 优先本地注册 handler（测试 stub），回落 `call_host` 走 stdio 往返。`check_permission` 传 `None` 超时。
- **`NapiHostCallbacks`**（napi-rs）：callback registry 模式 — TSFN 只传 `callbackId: u32`，JS 经 `getCallbackPayload(id)` 取载荷、`resolveCallback(id, err, result)` 回解；`invoke_via_registry(tsfn, input, label, timeout, cancel)` 统一实现「超时 + 取消观察」（`wait_for_callback` 每 100ms 轮询 turn 的 `AtomicBool` cancel flag）。

装饰器：`NativeToolCallbacks`（原生工具执行 + 权限门）、`CountingCallbacks`（事件计数 + 进程内 `EventBus` 广播）。`EventBus`（`src/events/`）是进程内订阅/发布，与宿主通道无关。

**关键先例：`check_permission` 就是「引擎发问、宿主应答、人在回路」的现成形状** — 无超时（放弃等待会丢弃用户已授予的批准）、取消可中断（turn 取消不搁置等待）。反向交互协议应与其完全同构。

### 2.2 v2 交互语义（`agent-core-v2/src/agent/tools/ask-user-question/`）

- **工具输入**（zod schema）：`questions[]`（1–4 个），每项 `question`（唯一文本）、`header`（≤12 字符分类标签）、`options[]`（2–4 个，`label` + `description`，label 项内唯一）、`multi_select`；可选 `background: true`。
- **前台**：`question.request({turnId, toolCallId, questions}, {signal, agentId})` → `Promise<QuestionResult>`。结果三态：
  - `null` = 用户关闭（dismissed）→ 工具输出 `{answers: {}, note: "User dismissed the question without answering."}`
  - `QuestionAnswers` = `Record<questionText, string | true>`（multi_select 为逗号分隔标签；Other 为用户自填文本）
  - `QuestionResponse` = `{answers, method: 'enter' | 'space' | 'number_key'}`
- **后台**：`QuestionBackgroundTask` 注册进 `IAgentTaskService`（`{detached: true}`），立即返回 `task_id` + `description` + `status` + `automatic_notification: true`；答案经任务系统在**后续 turn** 送达（模型调 TaskOutput），不轮询。
- **底层**：`ISessionQuestionService`（Session 作用域）→ `requestSessionInteraction` → `AgentInteraction` runtime（durable xstate actor）：
  - `request()` park 一个 promise；`respond(id, result)` 解；`dismiss(id)` 以 `null` 解
  - **turn 结束** → `cancelTurnPending` 以 `{cancelled: true, reason: 'turn_ended'}` 解
  - **abort signal** → dismiss
  - **无超时语义**：问题一直等到回答 / 关闭 / turn 结束
- 宿主侧 UI 渲染：interaction runtime 的 pending 状态（`InteractionRequestEvent` / `InteractionResolvedEvent` 是 durable wire 记录）。

### 2.3 双通道现状（`packages/kimi-agent/rust-loop.ts`）

- **napi**：`runTurnRust` 现有 7 个回调（llm_chat / execute_tool / emit_event / check_permission / finalize_tool / drain_steers），JS 侧 `makeCallbackHandler` 统一包装（取载荷 → 调用户 handler → resolveCallback）。
- **stdio**：`AgentProcess` 按 method 分发 `host/*` 请求（`handleHostRequest`），`host/event` 通知在 `processBuffer` 里走 `eventHandler`；宿主→引擎方向已有 `agent/run_turn`、`agent/cancel_turn` 请求先例。
- 宿主拥有：transcript（step.begin/end、tool.call/result 经 `dispatchEvent`）、消息历史（`buildMessages`）、工具生命周期（`input.executeTool` → 权限门 + 执行 + finalize）、steer 队列（`input.drainSteers`）。
- `TurnEngineInput`（`agent-core-v2/src/agent/loop/engineOverride.ts`）现有可选能力：`checkToolPermission?`、`finalizeToolResult?`、`getGoal?`、`replaceToolResult?` — **没有 `askUserQuestion`**，需新增。

## 3. 协议消息格式（wire JSON）

### 3.1 引擎 → 宿主：`host/ask_question`（请求/响应）

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "host/ask_question",
  "params": {
    "question_id": "question_9f2c…",      // 引擎生成，响应中原样回显
    "turn_id": "turn-42",
    "tool_call_id": "call_abc",
    "background": false,                   // true = 后台问（见 5.3）
    "timeout_ms": null,                    // null = 无限等待（v2 语义）；非 null 时宿主到期自动 dismiss
    "questions": [
      {
        "question": "Which approach should I take?",
        "header": "Style",
        "options": [
          { "label": "Option A (Recommended)", "description": "Fast, less flexible" },
          { "label": "Option B", "description": "Slower, more flexible" }
        ],
        "multi_select": false
      }
    ]
  }
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `question_id` | string | 引擎生成的唯一 id（`question_<uuid>`），宿主 interaction runtime 以它为 pending key；响应回显 |
| `turn_id` / `tool_call_id` | string | 溯源：宿主在 turn 结束时按 turn 取消 pending 问题；tool_call_id 供 UI 关联工具卡片 |
| `background` | bool | 默认 false。true 时宿主注册后台任务并立即返回 task_id（见 3.3） |
| `timeout_ms` | number \| null | 可选扩展。v2 无超时；宿主不支持时忽略。null = 无限等待（与 check_permission 一致） |
| `questions` | array | 1–4 项，字段与 v2 `QuestionItem` 一一对应（question / header / options[2–4] / multi_select） |

**响应（前台，已回答）**：

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "answers": { "Which approach should I take?": "Option A (Recommended)" },
    "method": "enter"
  }
}
```

**响应（前台，关闭 / 取消）** — 与 v2 三态一一对应：

```json
{ "result": { "answers": {}, "note": "User dismissed the question without answering." } }
{ "result": { "cancelled": true, "reason": "turn_ended" } }
```

- dismissed：`answers` 为空对象 + `note`（v2 `dismissedQuestionResult` 的 wire 镜像）
- cancelled：`{cancelled: true, reason}`（v2 `cancelTurnPending` 的 wire 镜像；reason 取值 `turn_ended` / `agent_closed` / `timeout`）

**错误**：宿主未接线 → JSON-RPC error（`-32603`，消息含「does not support interactive questions」）；引擎把错误映射为工具结果，文案对齐 v2 的 `QUESTION_UNSUPPORTED_FAILURE_MESSAGE`（「Do NOT call this tool again. Ask the user directly in your text response instead.」）。

### 3.2 宿主 → 引擎：`agent/question_answer`（异步答案送达，仅引擎自持任务状态时需要）

首版（后台任务状态归宿主）**不需要**此通道 — 见 5.3。当第 7 批引擎吸收 task 族、后台问题状态归引擎时启用：

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "method": "agent/question_answer",
  "params": {
    "question_id": "question_9f2c…",
    "result": { "answers": { "…": "…" }, "method": "enter" }
  }
}
```

- `result` 为 `null` 表示 dismissed；`{cancelled: true, reason}` 表示取消。
- stdio：`RpcServer` 注册 handler（`handle_incoming` 已支持 host→engine 请求分发），路由到引擎内 `QUESTION_REGISTRY`（`question_id → oneshot`）解挂起的等待。
- napi：新增导出 `resolve_question(question_id: String, result_json: Option<String>)`，镜像 `resolve_callback` / `CANCEL_MAP` 的全局注册表模式。

### 3.3 后台响应（`background: true`）

宿主注册 `QuestionBackgroundTask` 后，把 v2 工具的输出**原样透传**给引擎作为工具结果：

```json
{
  "result": {
    "task_id": "question_9f2c…",
    "description": "Which approach should I take?",
    "status": "running",
    "automatic_notification": true,
    "next_step": "Continue your current work; the answer will arrive automatically when the user responds."
  }
}
```

引擎不解析 task 语义 — TaskOutput / TaskStop 首版仍是宿主工具（经 `host/execute_tool` 回落），任务状态权威在宿主。

## 4. napi/stdio 双通道传递方式

**结论：新增请求/响应回调，不复用事件通道。**

事件通道（`emit_event` / `host/event`）是 fire-and-forget：JS 取载荷后不 resolve，无响应路径。问题需要「答案 / 关闭 / 错误」三种响应，事件通道无法表达；若强行「事件发问 + 独立应答通道」则引入两条通道的排序与错误传播问题。`check_permission` 已证明请求/响应回调是正确形状。

| 通道 | 做法 | 落点 |
|---|---|---|
| **stdio** | 新 method 常量 `HOST_ASK_QUESTION = "host/ask_question"`；`RpcHostCallbacks::ask_question` → `server.invoke(HOST_ASK_QUESTION, params, None)`（无超时，人在回路；测试用 `register_arc` 本地 stub，无需起子进程） | `src/rpc/types.rs` + `src/callbacks.rs` |
| **napi** | `run_turn_rust` 新增可选 `ask_question_cb`（第 8 个参数，`drain_steers_cb` 之后）；`NapiHostCallbacks` 经 `invoke_via_registry(tsfn, input, "ask_question", None, cancel)` — 复用现成的无超时 + 取消观察 | `src/napi_bindings.rs` |
| **JS 侧** | napi 分支：`NapiEngine.runTurn` 增 `askQuestionCb?`，`makeCallbackHandler` 包装；stdio 分支：`AgentProcess.setAskQuestionHandler` + `handleHostRequest` 分发 | `packages/kimi-agent/rust-loop.ts` |
| **宿主能力** | `TurnEngineInput` 新增可选 `askUserQuestion?(req): Promise<QuestionResult>`，由 `loopService.ts`（构造 TurnEngineInput 处）从 session question 服务接线 — 与 `checkToolPermission` / `finalizeToolResult` 同模式 | `agent-core-v2/src/agent/loop/engineOverride.ts` |

事件通道角色不变：transcript / 流式 delta / 原生工具结果。`CountingCallbacks` / `NativeToolCallbacks` 装饰器对新增 trait 方法自动转发（见第 7 节），零新管道。

## 5. 不阻塞 step 循环的机制

### 5.1 等待模型（前台）

「不阻塞」的确切含义：**阻塞的是该工具调用对应的 tokio future，不是 tokio runtime / RPC 循环 / 事件通道**。等待期间：

- stdio：`RpcServer` 的 stdin 读取循环与 `handle_incoming` 照常运行 — `agent/cancel_turn`、`agent/question_answer` 等 host→engine 请求仍被处理
- napi：TSFN 通道照常投递 — `cancel_turn` 导出仍可置位 cancel flag

中断三通道（与 `check_permission` 完全同构）：

1. **turn 取消**：napi 侧 `wait_for_callback` 每 100ms 观察 cancel flag；stdio 侧宿主在 turn abort 时 abort 其 handler → 错误响应回传（现有 `check_permission` 的 stdio 取消依赖宿主，见第 9 节遗留）
2. **可选超时**：`timeout_ms` 非 null 时引擎侧 `tokio::time::timeout` 包住等待，到期返回 `{cancelled: true, reason: "timeout"}` 作为工具结果；默认 null = 无限等待（v2 语义，人在回路）
3. **宿主关闭**：用户 dismiss → `{answers: {}}`；turn 结束 → `{cancelled: true, reason: "turn_ended"}`（宿主 interaction runtime 的 `cancelTurnPending` 已按 turnId 取消，无需引擎参与）

### 5.2 与 drain_steers 的关系

`drain_steers` 只在 step 头调用（`run_turn.rs` 每步 LLM 调用前）。问题等待发生在工具执行内部，期间用户注入的 steer 在宿主 step 队列排队，答案到达后下一个 step 头被排空 — **与 JS 循环行为完全一致，无需改动**。

可选增强（宿主侧产品决策，引擎不参与）：TUI 在收到 steer 时 dismiss 挂起的问题卡片 — 宿主拥有 interaction runtime，`dismiss(id)` 即可，引擎侧表现为正常 dismissed 响应。

### 5.3 后台（background）非阻塞

工具立即返回 `task_id`（3.3），step 循环继续。答案经宿主任务系统在后续 turn 送达（模型调 TaskOutput 读取）— **首版零新增异步机制**，`agent/question_answer` 通道（3.2）只在引擎自持任务状态时启用。

### 5.4 并发与调度

首版 ask-user-question 走宿主执行路径（引擎 `handles()` 白名单不含它 → `host/execute_tool` 回落），调度语义与 JS 循环一致，无需改动。引擎原生吸收后（第 7 批），`infer_tool_accesses` 需让 ask-user-question 与一切工具冲突（串行化），避免同批并发工具在问题卡片弹出时继续执行 — 与宿主 JS 循环的 ToolAccesses 语义对齐。

## 6. 状态层归属建议（todo/plan 持久化 + undo）

**推荐方案 A：写穿桥接（write-through bridge）— 宿主保持状态权威，引擎持有 in-turn 缓存。**

- 引擎原生 todo/plan 工具经新 host 回调读写宿主状态：`host/state_read {domain, key}` → `{value}`；`host/state_write {domain, key, value, undoable}` → `{ok}`（精确 schema 第 7 批落码时细化，可按 domain 拆 `host/todo_read` 等）
- 宿主保持：持久化（append-log / atomic-doc store）、**undo 协议**（`defineState(...).replayable(...).undoable()` 链、checkpoint/rollback fold、逆补丁）、compaction、replay — 全部唯一权威
- 引擎内可做读穿 + 写穿缓存（turn 内多次读不往返），但缓存不是权威，undo/compaction 后失效重读

**方案 B（不推荐）：引擎自持持久化 + 自实现 undo。** 引擎已有 `src/storage/`（session JSONL），但 undo 是宿主会话级协议：`context.undo` 是唯一持久化 undo 事实，undo 锚点、checkpoint fold、逆补丁、compaction 裁剪与 transcript 层强耦合 — 引擎复制它等于复制半个 transcript 层，且双份状态必然分叉（与 ROADMAP 已否决的「Rust 本地权限快速路径」同理：任何简化都会造成语义分叉）。

**理由**：D-2 的「完整 runtime」目标是**控制流完整**（引擎驱动整个 turn），不是状态权威转移 — 与权限（宿主权威，逐调用往返）同理。todo/plan 的持久化 + undo 留在宿主，引擎经桥接读写，是成本最低且不 fork 语义的路径。

## 7. 与 HostCallbacks 的集成点

**新增 trait 方法（推荐），不建独立通道：**

```rust
fn ask_question(
    &self,
    request: AskQuestionRequest,
) -> BoxFuture<'static, Result<AskQuestionResponse, String>> {
    Box::pin(async { Err("host does not support interactive questions".into()) })
}
```

理由：

1. **形状一致**：请求/响应 + 人在回路 + 取消可中断，与 `check_permission` 完全同构，trait 已建模此形状
2. **装饰器零成本**：`NativeToolCallbacks` / `CountingCallbacks` 转发新方法只需各加一行转发（或默认实现 + 显式转发），不建新管道
3. **优雅降级**：默认实现返回「不支持」错误，未接线的宿主得到与 v2 `QUESTION_UNSUPPORTED_FAILURE_MESSAGE` 对齐的工具结果，模型被明确告知不要重试

**反向通道不进 trait**：`agent/question_answer`（stdio method）+ `resolve_question`（napi 导出）是 host→engine 方向，trait 只建模 engine→host — 与现有 `agent/cancel_turn` + `cancel_turn` 导出的分工一致。

**新增类型**（`src/rpc/types.rs`）：`AskQuestionRequest`（question_id / turn_id / tool_call_id / background / timeout_ms / questions[]）、`AskQuestionResponse`（answers / method / note / cancelled / reason 的 serde 联合，镜像 v2 `QuestionResult` 三态）。超时常量不新增默认上限 — 人在回路，同 `check_permission`；`timeout_ms` 由调用方按需携带。

## 8. 实施顺序（落码里程碑）

1. `src/rpc/types.rs`：`AskQuestionRequest` / `AskQuestionResponse` + `methods::HOST_ASK_QUESTION` + 序列化 round-trip 测试
2. `src/callbacks.rs`：`HostCallbacks::ask_question` 默认实现 + `RpcHostCallbacks` 实现（`invoke(..., None)`）+ 装饰器转发
3. `src/napi_bindings.rs`：`run_turn_rust` 新增可选 `ask_question_cb` + `NapiHostCallbacks` 实现（`invoke_via_registry(..., None, cancel)`）
4. `packages/kimi-agent/rust-loop.ts`：napi 分支传第 8 回调；stdio 分支 `setAskQuestionHandler` + `handleHostRequest` 分发
5. `agent-core-v2`：`TurnEngineInput.askUserQuestion?` + `loopService.ts` 从 session question 服务接线
6. 引擎原生 AskUserQuestion 工具（`src/tools/`）：前台 + 后台透传（`background` 原样转发，task 语义归宿主）
7. 测试：stdio round-trip（`register_arc` stub）、napi 集成、取消中断（cancel_turn 打断等待）、dismiss、后台 task_id 透传
8. 第 7 批：状态桥接（todo/plan 写穿）+ 引擎自持任务状态时启用 `agent/question_answer`

## 9. 风险与遗留问题

- **stdio 取消不对称**：`RpcHostCallbacks.check_permission` 不观察引擎侧 cancel flag（依赖宿主 abort handler 回传错误）。ask_question 首版沿用该模式；后续可在 `call_host_value` 增加 cancel flag 参数统一两条路径（涉及 `server.rs`，独立小改动）
- **超时语义分叉**：v2 无超时；`timeout_ms` 是扩展字段，宿主可忽略 — 引擎不得依赖宿主执行超时，超时只作引擎侧兜底
- **并发问题卡片**：同批多问（v2 同样存在），宿主 interaction runtime 按 id 区分；引擎原生吸收后需串行化（5.4）
- **后台任务状态归属**：首版宿主侧（零新增异步机制）；引擎吸收 task 族时再启用 3.2 通道
- **与并行子代理的边界**：本文档只设计不改码；落码按第 8 节顺序推进，每步 `cargo check` 验收