# Rust 引擎状态桥接协议设计（host/state_read + host/state_write）

> 状态：**设计草案（待审阅）** — 基于当前代码快照调研（只读，未改任何 src/ 文件），落码前需按第 6 节顺序推进并逐项验收。
> 目标读者：本仓库维护者。本文档是 `reports/rust-engine-reverse-protocol-design.md` 第 6 节「状态层归属（方案 A：写穿桥接）」的细化设计，不是 commit 记录。
> 关联决策：D-2（引擎做完整 runtime，宿主状态与人机交互类工具在目标范围内）；第 4 批反向交互协议已落码（`host/ask_question` 全链路可用）。

## 1. 背景与目标

第 4 批已落码的反向交互协议（`host/ask_question`）解决了「引擎向宿主发问并等回答」；本文档细化另一半地基——**状态层归属**。设计文档第 6 节已定方向：

- **方案 A（写穿桥接）**：引擎原生 todo/plan 工具经新 host 回调读写宿主状态（`host/state_read {domain, key}` → `{value}`；`host/state_write {domain, key, value, undoable}` → `{ok}`），宿主保持持久化 + undo 唯一权威。
- 精确 schema 标注「第 7 批落码时细化」——本文档完成该细化。

本文档回答五个问题：

1. `host/state_read` / `host/state_write` 精确 wire schema（字段、错误码、与 `HOST_ASK_QUESTION` 的同构性）
2. 引擎侧 TodoList / EnterPlanMode 原生工具的实现方案（参数解析、状态读写、输出格式对齐 v2）
3. 宿主侧接线方案（agent-core-v2 的 state 服务暴露、undoable 链保持）
4. 落码里程碑（分步 + 每步验收）
5. 范围决策：ExitPlanMode 首版保持 host 路径的理由

不在本文档范围：goal / cron / task 族等其他状态域（桥接是通用通道，新增域只需宿主适配器 + 引擎工具，本文档以 todo/plan 为样板）、子代理递归、`agent/question_answer` 反向通道（第 7 批引擎自持任务状态时启用，与本桥接无关）。

## 2. 现状调研摘要

### 2.1 v2 todo 状态（`agent-core-v2/src/features/todo/`）

- **状态 key**：`AgentTodo` runtime（`todoAgentRuntime.ts`），`defineAgentRuntimeContract<TodoRuntime>('todo')`，durable 事件 `[ToolsUpdateStore]`，`durable.undoable = true`。状态值 `TodoState = readonly TodoItem[]`，存于 xstate actor context，经 `runtime.restore` 从 durable 事件恢复。
- **写入路径**：`TodoRuntime.replace(todos)` → `context.dispatch(new ToolsUpdateStore({agentId, key: 'todo', value: todos}))`。`ToolsUpdateStore` 是 durable 事件（`todoOps.ts`），transition fold 用 `readTodoItems(event.value)` 归一化后落 actor context。
- **wire 形状**（`todoItem.ts`）：

```ts
interface TodoItem {
  readonly id: string;              // 缺失时分配：根级 T1/T2…，子级 <parentId>.1…
  readonly parentId: string | null;
  readonly kind: 'milestone' | 'task';
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
  readonly progress?: number;       // 0–100，归一化取整
  readonly description?: string;
}
```

- **工具契约**（`tools/todo-list/todo-list.ts`）：输入 `{todos?: Array<{title, status}>}`——省略 = 读，空数组 = 清空，非空 = 整体替换（**全量 replace，无增量 patch**）。
- **输出格式**（`todoListTool.ts` + `todoItem.ts`）：
  - 读：`renderTodoList(todos)` → `Current todo list: (overall X/Y · Z%)` + 树形行（`[pending]`/`[in_progress]`/`[done]` 标记 + id + title + 进度后缀）；空列表 → `Todo list is empty.`
  - 写：`Todo list updated.\n<render>\n\n<TODO_LIST_WRITE_REMINDER>`（reminder 文案：`Ensure that you continue to use the todo list to track progress. …`）；清空 → `Todo list cleared.`
- **undoable 语义**：todo 是 Agent Runtime durable + undoable——`context.undo` 经 dispatcher 的 undoable 协议（undo 锚点 checkpoint、逆补丁回滚、compaction/clear 裁剪 checkpoint）回滚 `ToolsUpdateStore` 事件。`undoService.ts` 的 `checkpointDepth()` 遍历 `agentState.replayableKeys()` + runtime checkpoint 深度做 pre-cut 检查。

### 2.2 v2 plan 状态（`agent-core-v2/src/features/plan/`）

- **状态 key**：`planKey = defineState('plan', () => ({active: false})).replayable({schema}).undoable().on(PlanModeEnter/PlanModeCancel/PlanModeExit/PlanRevision)`（`planOps.ts`），由 `AgentPlanService` 构造时 `agentState.contributeState(planKey)` 贡献到 **Agent 作用域 state 服务**（`IAgentStateService`，`agentStateService.ts`）。
- **wire 形状**：

```ts
interface PlanState {
  readonly active: boolean;
  readonly id?: string;                              // 宿主生成（hero slug）
  readonly revisionCount?: Readonly<Record<string, number>>;
}
```

- **plan 内容不在 state 里**：正文在宿主文件 `<sessionDir>/agents/<agentId>/plans/<id>.md`（`planFilePathFor`），`status()` 经 `hostFs.readText` 读回 `{id, content, path}`（`PlanData`）。引擎不知道 sessionDir——**路径必须由宿主在桥接响应中回传**。
- **durable 事件**：`PlanModeEnter {agentId, id}` / `PlanModeExit {agentId, id?}` / `PlanModeCancel` / `PlanRevision`，全部 durable；`planKey` 链 `.undoable()`——enter/exit 都参与会话 undo。
- **工具契约**：
  - `EnterPlanMode`：输入 `{}`（strict）。已激活 → `{isError: true, output: 'Plan mode is already active. Use ExitPlanMode when the plan is ready.'}`；成功 → `enteredPlanModeMessage(path)`（含 plan 文件路径的工作流说明，无路径时给降级文案）。
  - `ExitPlanMode`：输入 `{options?: [{label, description}]}`（1–3 项，保留标签校验）。非 auto 模式走 `plan_review` display + `ExitPlanModeReview.requestApproval`（用户批准）；auto 模式直通。输出含 plan 全文。
- **plan 模式守卫**：`registerPlanGuard` 在 `onBeforeExecuteTool` veto 链上拦截 plan 模式下的 Write/Edit（仅放行 plan 文件）、TaskStop、CronCreate/Delete——**这是宿主监听器链，引擎原生路径不经过**（与 ROADMAP 4.8 节 D-1 结论同源：`check_permission` 走 `authorize`，不进 veto 链）。

### 2.3 Rust 侧现状（`packages/kimi-agent/`）

- **`HostCallbacks` trait**（`src/callbacks.rs`）：8 个方法（llm_chat / execute_tool / check_permission / ask_question / finalize_tool_result / drain_steers / emit_event / cancel_llm_chat）。`ask_question` 是「新增 trait 方法 + 默认不支持实现 + 装饰器转发」的现成先例——状态桥接完全复用该模式。
- **两个实现**：`RpcHostCallbacks`（stdio，`server.invoke(method, params, timeout)`）、`NapiHostCallbacks`（napi，callback registry + `invoke_via_registry(tsfn, input, label, timeout, cancel)`）。装饰器 `NativeToolCallbacks` / `CountingCallbacks` 对新增方法各加一行转发。
- **`NativeToolset`**（`src/tools/mod.rs`）：`handles()` 白名单决定哪些工具原生执行；`with_callbacks(base_callbacks)` 已把**基础回调**（非 NativeToolCallbacks 包装，避免递归）注入 toolset，`ask_user_question` 经 `self.callbacks` 调 `ask_question`——状态桥接工具走同一通道。
- **权限门**：`NativeToolCallbacks.execute_tool` 对**每个**原生执行（含只读）先 `check_permission`，deny 即工具结果。TodoList 写 / EnterPlanMode 自动被门覆盖，与 v2 的 `approvalRule: this.name` 对齐。
- **超时常量**：`HOST_LLM_TIMEOUT`(900s) / `HOST_TOOL_TIMEOUT`(600s) / `HOST_FINALIZE_TIMEOUT`(30s) / `HOST_DRAIN_TIMEOUT`(30s)。状态读写是宿主簿记、无人在回路——用 30s 量级。

## 3. wire schema

**结论：通用双方法（`domain` 判别），不按域拆方法。** 设计文档第 6 节留了「可按 domain 拆 `host/todo_read` 等」的口子；通用形式更优：方法数恒定、宿主按 domain 分发、未来 goal/cron/task 域零协议改动。`domain` + `key` 双字段是为「域内多 key」预留（如 task 域将来有 `task` 注册表 + `taskNotificationDelivery` 两个 key）；todo/plan 首版 `domain == key`。

### 3.1 引擎 → 宿主：`host/state_read`（请求/响应）

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "host/state_read",
  "params": {
    "domain": "todo",
    "key": "todo",
    "turn_id": "turn-42",
    "tool_call_id": "call_abc"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `domain` | string | 状态域判别：`"todo"` / `"plan"`（未来 `"goal"` / `"cron"` / `"task"`）。未知域 → `-32001` |
| `key` | string | 域内状态 key。首版恒等于 domain；未知 key → `-32002` |
| `turn_id` / `tool_call_id` | string | 可选溯源（serde default 空串），宿主可忽略；与 `host/ask_question` 的溯源字段同构 |

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "value": [
      { "id": "T1", "parentId": null, "kind": "task", "title": "Read session-control.ts", "status": "in_progress", "progress": 40 },
      { "id": "M1", "parentId": null, "kind": "milestone", "title": "Phase 1", "status": "pending" }
    ]
  }
}
```

- `value` 是**域 wire 值**（opaque JSON，宿主权威序列化）：
  - todo 域：`TodoItem[]`（§2.1 wire 形状）
  - plan 域：`{active: boolean, id?: string, path?: string}`——`path` 是宿主附加元数据（当前 plan 文件路径，非 durable 状态），供引擎渲染 v2 对齐输出；`content` 首版不返回（引擎工具不需要，见 §4.3）
- 不返回 revision/版本号：v1 引擎不做跨调用缓存（见 §4.6），无失效检测需求。

### 3.2 引擎 → 宿主：`host/state_write`（请求/响应）

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "host/state_write",
  "params": {
    "domain": "todo",
    "key": "todo",
    "value": [ { "title": "Read session-control.ts", "status": "in_progress" } ],
    "undoable": true,
    "turn_id": "turn-42",
    "tool_call_id": "call_abc"
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `domain` / `key` | string | 同 3.1 |
| `value` | JSON | 域 wire 值。todo：`TodoItem[]`（引擎已归一化，宿主**重新归一化**——权威）；plan：`{active: true}` = enter、`{active: false}` = exit（命令形部分状态，宿主补全 id/path） |
| `undoable` | bool | 引擎对该写操作的 undo 语义声明。宿主是权威：todo/plan 域在 v2 恒为 undoable，宿主按域语义落 durable 事件；字段为未来非 undoable 域（goal/cron/task 注册表）预留，宿主可忽略 |
| `turn_id` / `tool_call_id` | string | 可选溯源，同 3.1 |

**响应**：

```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "result": {
    "ok": true,
    "value": [
      { "id": "T1", "parentId": null, "kind": "task", "title": "Read session-control.ts", "status": "in_progress" }
    ]
  }
}
```

- `value` = **宿主应用域语义后的结果状态**（可能不同于提交值：todo 经 `readTodoItems` 补 id；plan enter 后带宿主生成的 `id` + `path`）。引擎用它渲染输出，免二次读往返。
- plan enter 示例响应：`{"ok": true, "value": {"active": true, "id": "plan-7f3a", "path": "<sessionDir>/agents/agent-1/plans/plan-7f3a.md"}}`

### 3.3 错误码

| code | 含义 | 引擎映射 |
|---|---|---|
| `-32603` | 宿主未接线（消息含 **`does not support state bridge`** 短语） | 工具结果：告知模型宿主不支持、不要重试（对齐 `QUESTION_UNSUPPORTED_FAILURE_MESSAGE` 模式） |
| `-32001` | unknown domain | 工具结果错误（含域名校验消息） |
| `-32002` | unknown key | 工具结果错误 |
| `-32003` | invalid value（宿主 schema 校验/归一化失败） | 工具结果错误（透传宿主校验消息） |
| `-32004` | write rejected（域拒绝写入，如 plan 已激活时 enter → v2 `SESSION_PLAN_MODE_INVALID`） | 工具结果错误 |

- 引擎侧兜底：非上述已知错误一律视为瞬时宿主故障 → 工具结果错误（透传消息），**不重试**（写操作重试可能双写）。

### 3.4 与 `HOST_ASK_QUESTION` 的同构性

| 维度 | ask_question | state_read / state_write |
|---|---|---|
| 方向 | engine → host，JSON-RPC 请求/响应 | 同 |
| trait 方法 | `ask_question` + 默认「不支持」错误实现 | `state_read` / `state_write` + 默认「不支持」错误实现 |
| 传输 | stdio `server.invoke` / napi `invoke_via_registry` | 同（`RpcHostCallbacks` / `NapiHostCallbacks` 各加两个方法） |
| 装饰器 | `NativeToolCallbacks` / `CountingCallbacks` 各一行转发 | 同 |
| 超时 | `None`（人在回路） | **`Some(30s)`**（宿主簿记，无人在回路；新增 `HOST_STATE_TIMEOUT` 常量，与 `HOST_FINALIZE_TIMEOUT` 同量级） |
| 取消 | cancel flag 观察 | 不需要（30s 有界等待，turn 取消时随 future drop 自然放弃） |
| 未接线降级 | 工具结果「不支持，不要重试」 | 同 |

差异点：ask_question 无超时（人等回答），state 有界（30s）；ask_question 响应三态，state 响应单态 `{value}` / `{ok, value}`。

## 4. 引擎侧原生工具实现方案

### 4.1 TodoList（`src/tools/todo_list.rs`）

**执行流** `execute_todo_list(callbacks, args)`：

1. **参数解析**：`todos?: Array<{title: string, status: 'pending'|'in_progress'|'done'}>`（镜像 v2 `TodoListInputSchema`）。`todos` 缺失 = 读；空数组 = 清空；非空 = 替换。非法形状（title 空串、status 非法）→ 错误工具结果（对齐 v2 zod 校验语义）。
2. **读模式**（无 `todos`）：`state_read {domain: "todo", key: "todo"}` → `value` → `render_todo_list(value)` → 输出。空列表 → `Todo list is empty.`
3. **写模式**：`read_todo_items(value)` 归一化（补 id、progress 取整钳制）→ `state_write {domain: "todo", key: "todo", value: normalized, undoable: true}` → 响应 `value`（宿主归一化结果）→ 空 → `Todo list cleared.`；非空 → `Todo list updated.\n<render>\n\n<TODO_LIST_WRITE_REMINDER>`（reminder 文案逐字对齐 v2 `todo-list-write-reminder.md`）。
4. **错误映射**：§3.3 表。`-32603` 含 `does not support state bridge` → 失败消息「宿主不支持状态桥接，不要重试」；其余 → 错误工具结果透传。

**工具定义** `todo_list_tool_def()`：name `TodoList`（v2 工具名，`TODO_LIST_TOOL_NAME`），description 对齐 v2 `todo-list.md` 摘要，input_schema 镜像 `TodoListInputSchema`（`todos` optional + describe 文案）。

### 4.2 EnterPlanMode（`src/tools/plan_mode.rs`）

**执行流** `execute_enter_plan_mode(callbacks, args)`：

1. **参数解析**：`{}`（strict，镜像 v2 `EnterPlanModeInputSchema`）。多余字段 → 错误。
2. **先读后写**：`state_read {domain: "plan", key: "plan"}` → `value.active == true` → 错误工具结果 `Plan mode is already active. Use ExitPlanMode when the plan is ready.`（v2 文案逐字对齐）。
3. **写**：`state_write {domain: "plan", key: "plan", value: {active: true}, undoable: true}` → 响应 `value`（`{active, id, path}`）→ 输出 `enteredPlanModeMessage(path)`（v2 文案：有 path 给「Plan file: <path> + 工作流」版，无 path 给降级版）。
4. **错误映射**：同 4.1；`-32004`（读后写间竞态，宿主已激活）→ 同一「already active」文案。

### 4.3 ExitPlanMode：首版保持 host 路径（范围决策）

`handles()` 白名单**不含** ExitPlanMode，模型调用时经 `host/execute_tool` 回落宿主。理由：

1. **plan_review display 是宿主 UI 能力**：非 auto 模式必须展示 plan 全文 + options 评审卡并等用户批准；`check_permission` 权限门只能给通用批准卡片，给不了评审卡。
2. **veto 链旁路**：plan 模式守卫（Write/Edit 拦截等）注册在宿主 `onBeforeExecuteTool` 监听器链上，引擎原生路径不经过（§2.2 末）。ExitPlanMode 原生化会把「退出 plan 模式」与「守卫链」割裂。
3. 状态桥接已覆盖 EnterPlanMode 与 TodoList 两个无 UI 交互的工具；ExitPlanMode 待 ask_question 协议扩展 display kind（或宿主评审卡经 `host/execute_tool` 保持）时再评估。

引擎侧 plan 域读（`state_read`）仍有用：EnterPlanMode 的 already-active 检查。`content` 首版不返回——引擎工具不需要 plan 正文。

### 4.4 纯函数移植（`src/tools/todo_item.rs`）

调研报告（`rust-engine-state-tools-survey.md` §3）已把 todo 渲染列为「纯计算可直移」。移植两个函数并做 **golden 测试**（与 v2 输出逐字符对齐）：

- `read_todo_items(raw: &Value) -> Vec<TodoItem>`：镜像 v2 `readTodoItems`——校验 title/status、progress 归一化（`min(100, max(0, round))`）、缺失 id 分配（根级 `T1`/`T2`…，子级 `<parentId>.1`…，跳过已占用 id）。
- `compute_todo_progress` / `render_todo_list(todos, title)`：镜像 v2——`(overall X/Y · Z%)` 头、milestone 聚合进度（children 均值）、树形行 `[pending]`/`[in_progress]`/`[done]` 标记 + `id: title` + 进度后缀、空列表 `Todo list is empty.`。

### 4.5 工具注册与白名单

- `src/tools/mod.rs`：`pub mod todo_list; pub mod plan_mode;`（或 `todo_item` 并入 `todo_list`）；`handles()` 增 `"todolist" | "todo_list" | "enterplanmode" | "enter_plan_mode"`；`execute_tool` 增对应分支（经 `self.callbacks` 调 `state_read`/`state_write`，`callbacks` 为 `None` 时回落 host——与 ask_user_question 同模式）。
- 工具 def 注册：与 `ask_user_question_tool_def` 同模式（REPL 工具列表 + 原生工具发现）。
- `is_mutating_tool`：当前仅列 write/edit/bash 且生产代码未引用（permission engine 有独立 evaluate 逻辑）。TodoList 写 / EnterPlanMode 的权限由 `NativeToolCallbacks` 的 check_permission 门全覆盖，**无需改**；但落码时需核实 `permission/mod.rs` 的本地策略评估（P26 批 3）对这两个工具名的 deny/ask 规则匹配，必要时在策略快照侧归类为 mutating（见 §7 遗留）。

### 4.6 缓存策略：v1 无跨调用缓存

设计文档第 6 节允许「读穿 + 写穿缓存」，但 **v1 不做**：每次工具调用都经桥接往返。理由：

- undo / compaction 可在 turn 进行中发生（用户 undo 不等待 turn 结束），引擎无法感知缓存失效；缓存不是权威，失效即错。
- 单次工具调用内无重复读（读模式一次 read，写模式一次 write），无缓存收益。
- 后续若长 turn 多次 TodoList 读成为热点，需宿主 → 引擎失效信号（`agent/state_invalidated` 通知，仿 `agent/question_answer` 反向通道模式）——列入 §7 遗留。

## 5. 宿主侧接线方案

### 5.1 `TurnEngineInput` 扩展（`agent-core-v2/src/agent/loop/engineOverride.ts`）

与 `askUserQuestion?` 同模式新增两个可选能力 + wire 类型（snake_case，镜像 Rust）：

```ts
export interface StateReadWire {
  readonly domain: string;
  readonly key: string;
  readonly turn_id?: string;
  readonly tool_call_id?: string;
}
export interface StateReadWireResult {
  readonly value: unknown;
}
export interface StateWriteWire {
  readonly domain: string;
  readonly key: string;
  readonly value: unknown;
  readonly undoable: boolean;
  readonly turn_id?: string;
  readonly tool_call_id?: string;
}
export interface StateWriteWireResult {
  readonly ok: boolean;
  readonly value?: unknown;
}

// TurnEngineInput 新增：
stateRead?(request: StateReadWire): Promise<StateReadWireResult>;
stateWrite?(request: StateWriteWire): Promise<StateWriteWireResult>;
```

### 5.2 `loopService.ts` 适配器（`buildEngineInput` 处，与 `askUserQuestion` 同位置）

**stateRead**（按 domain 分发）：

- `"todo"`：`IAgentLifecycleService.resolve(scopeContext.agentContext, AgentTodo).get()` → `{value: todos}`。`IAgentLifecycleService` 经 `instantiation.invokeFunction` 惰性解析（与 `checkToolPermission` 的 `IAgentPermissionGate` 同模式，避免提前构造重排监听器顺序）。
- `"plan"`：`agentState.get(planKey)` → `{active, id?}` + 当前 plan 文件路径（`currentPlanFilePath` 逻辑）→ `{value: {active, id?, path?}}`。
- 其他 domain → throw（映射 `-32001`）。

**stateWrite**：

- `"todo"`：`todo.replace(readTodoItems(value))` → `{ok: true, value: todo.get()}`。**宿主重新归一化**——引擎提交的 value 只作输入，权威归一化在宿主（`readTodoItems` 补 id）。
- `"plan"`：`value.active === true` → `plan.enter()`（宿主生成 id + 建目录 + dispatch `PlanModeEnter`）；`value.active === false` → `plan.exit()`。返回 `{ok: true, value: {active, id?, path?}}`（`status()` 后组装）。已激活时 enter → 捕获 `Error2(SESSION_PLAN_MODE_INVALID)` → 映射 `-32004`。
- 其他 domain → throw（`-32001`）。

### 5.3 undoable 链保持（核心约束）

宿主适配器**只调 v2 既有服务方法**，不新建写入路径：

- todo 写 → `TodoRuntime.replace` → `ToolsUpdateStore` durable 事件 → AgentTodo runtime 的 undoable fold（checkpoint / 逆补丁 / compaction 裁剪）**零改动**。
- plan 写 → `AgentPlanService.enter/exit` → `PlanModeEnter/Exit` durable 事件 → `planKey` 的 `.undoable()` 协议 fold **零改动**。

`context.undo` 的 `checkpointDepth()`（`undoService.ts`）遍历 `replayableKeys()` + runtime checkpoint 深度——todo/plan 的 checkpoint 由 dispatcher 按既有协议维护，桥接写入与 v2 工具写入**在 undo 链上不可区分**。引擎从不直接写持久化层（append-log / atomic-doc / 逆补丁全在宿主）。

### 5.4 权限与调度

- **权限**：`NativeToolCallbacks.execute_tool` 对 TodoList / EnterPlanMode 原生执行先 `check_permission`（宿主全量权限机制：模式/规则/策略/交互批准），deny 即工具结果——与 v2 `approvalRule: this.name` 对齐，零新增。
- **调度**：TodoList / EnterPlanMode 无文件 accesses → 与其余工具并行安全；同批两个 TodoList 写并发时 last-write-wins——**与 v2 一致**（v2 `TodoListTool.resolveExecution` 同样不声明 accesses，JS 调度器不串行化）。不新增合成资源。

### 5.5 `rust-loop.ts` 接线

- **napi 分支**：`NapiEngine.runTurn` 增 `stateReadCb?` / `stateWriteCb?`（第 9/10 回调，`askQuestionCb` 之后）；`makeCallbackHandler` 包装（JSON 载荷 → 用户 handler → JSON 响应）。
- **stdio 分支**：`AgentProcess.setStateReadHandler` / `setStateWriteHandler` + `handleHostRequest` 分发 `host/state_read` / `host/state_write`（未接线 → `writeHostError(msg.id, 'host does not support state bridge')`，引擎映射为失败工具结果）。
- **`createRunTurnOverride`**：`const stateRead = input.stateRead?.bind(input) ?? options?.stateRead;`（同 `askUserQuestion` 的 input 优先模式）。

## 6. 落码里程碑

每步独立可验收；顺序执行，前步是后步前提。验收命令：Rust 侧 `cargo check` / `cargo test`（对应模块），TS 侧 `bun --bun run test`（对应测试文件）——**不跑全量**（与并行子代理冲突时只跑本步文件）。

| # | 内容 | 验收 |
|---|---|---|
| 1 | `src/rpc/types.rs`：`StateReadRequest` / `StateReadResponse` / `StateWriteRequest` / `StateWriteResponse` + `methods::HOST_STATE_READ` / `HOST_STATE_WRITE` | serde round-trip 测试（含默认字段缺省、`value` opaque JSON 透传） |
| 2 | `src/callbacks.rs`：`HostCallbacks::state_read` / `state_write` 默认实现（错误含 `does not support state bridge`）+ `RpcHostCallbacks` 实现（`invoke(..., Some(HOST_STATE_TIMEOUT))`，新增 30s 常量）+ `NativeToolCallbacks` / `CountingCallbacks` 转发 | 单测：默认实现报错、装饰器转发、RPC 参数序列化 |
| 3 | `src/napi_bindings.rs`：`run_turn_rust` 新增可选 `state_read_cb` / `state_write_cb`（`ask_question_cb` 之后）+ `NapiHostCallbacks` 实现（`invoke_via_registry(..., Some(30s), cancel)`） | `cargo check` + napi 集成测试（stub 回调往返） |
| 4 | `packages/kimi-agent/rust-loop.ts`：napi 分支传第 9/10 回调；stdio 分支 `setStateReadHandler` / `setStateWriteHandler` + `handleHostRequest` 分发；`createRunTurnOverride` 接 `input.stateRead/stateWrite` | rust-loop 单测：stdio 分发、未接线错误、napi 回调包装 |
| 5 | `agent-core-v2`：`TurnEngineInput.stateRead?` / `stateWrite?` + wire 类型 + `loopService.ts` 适配器（todo/plan 两域 + 错误映射） | engineOverride 契约测试：fake engine 断言 wire 形状；todo/plan 域读写经真实 service（`AgentTodo` / `AgentPlanService`） |
| 6 | Rust 纯函数移植：`src/tools/todo_item.rs`（`read_todo_items` / `compute_todo_progress` / `render_todo_list`） | golden 测试：与 v2 `renderTodoList` 输出逐字符对齐（含空列表、milestone 聚合、进度后缀、id 分配） |
| 7 | 引擎原生工具：`src/tools/todo_list.rs`（TodoList 读/写/清空）+ `src/tools/plan_mode.rs`（EnterPlanMode）+ `handles()` 白名单 + tool def | 单测：参数解析、读/写/清空输出对齐 v2 文案、already-active 检查、错误映射（未接线 / -32001 / -32003 / -32004） |
| 8 | 端到端：stdio round-trip（`register_arc` stub）、napi 集成、**undo 链保持**（宿主侧：桥接写 → `context.undo` → todo/plan 状态回滚）、权限门（deny → 工具结果） | 对应测试全绿；undo 用例证明桥接写入与 v2 写入在 undo 链上不可区分 |

## 7. 风险与遗留问题

- **缓存失效**：v1 无跨调用缓存（§4.6）；若长 turn 多次 TodoList 读成热点，需 `agent/state_invalidated` 反向通道（仿 `agent/question_answer` 模式）——独立小改动，不在本批。
- **ExitPlanMode 保持 host 路径**：plan_review display + 非 auto 批准是宿主 UI 能力（§4.3）；引擎侧 plan 域读已够 EnterPlanMode 用。后续若 ask_question 协议扩展 display kind 再评估。
- **plan 文件路径耦合**：引擎不知道 sessionDir，`path` 由宿主在 write 响应回传；宿主侧 `currentPlanFilePath` 逻辑需在适配器暴露（当前是 `AgentPlanService` 私有方法，落码时加只读访问面）。
- **veto 链旁路**：TodoList / EnterPlanMode 原生执行不经过 `onBeforeExecuteTool` 监听器链（plan 写拦截等）。TodoList 无文件写、EnterPlanMode 在 plan 模式外才合法，风险低；但落码时需确认无 feature 依赖对这两个工具的 veto（与 ROADMAP 4.8 节 D-1 结论同源，保持默认 false 的既有决策不变）。
- **permission engine 归类**：`permission/mod.rs` 本地策略评估（P26 批 3）对 TodoList / EnterPlanMode 的 deny/ask 规则匹配需落码时核实（`is_mutating_tool` 生产未引用，evaluate 有独立逻辑）；宿主 `check_permission` 门已兜底。
- **并发写**：同批两个 TodoList 写 last-write-wins，与 v2 一致（§5.4），不新增合成资源。
- **与并行子代理的边界**：本文档只设计不改码；落码按第 6 节顺序推进，每步只跑本步测试命令。