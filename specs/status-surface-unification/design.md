# Design — 输入框上方提示栏统一为单一「状态栏」模块

需求与事实依据见 `requirements.md`（F1–F20、R1–R9、D1–D3）。本文件给出落点、契约、取舍与被否决的方案。

## 0. 一句话设计

**一个容器 + 三个区域 + 一条状态推送**：

```
                  引擎（唯一状态源）                        TUI（唯一消费方）
   ┌──────────────────────────────────────┐      ┌───────────────────────────────┐
   │ AgentTodoService.replace/clear       │      │ StatusSurfaceComponent        │
   │        │                             │      │  ├─ ApprovalRegion            │
   │        ├─► ToolsUpdateStore (wire)   │      │  ├─ TodoRegion                │
   │        └─► TodoUpdated (observable)  │      │  └─ UpdatesRegion             │
   │                    │                 │      │                               │
   │        IEventBus ──┘                 │      │  （公共：预算/焦点/鼠标/i18n）│
   └────────────────────┬─────────────────┘      └───────────────▲───────────────┘
                        │ translateDomainEvent                  │
                        └────────► SDK Event 流 ────────────────┘
```

三个区域的数据来源**各有其合法性**（见 §1），但**进入容器的方式统一**，容器能力**只实现一次**。

## 1. 为什么三个区域的来源不同 —— 以及什么该统一、什么不该

先把"数据源"分成两层，否则会误判目标是"三个来源合成一个"：

| 层 | 含义 | 目标 |
| --- | --- | --- |
| **事实源**（authoritative state） | 这份状态的真身在哪个进程/哪个服务里 | **每个区域一个**，不与别区域共享 |
| **进入 UI 的通道**（delivery） | 事实源如何把变化送到容器 | **必须统一成一种**（区域接口 + 一个更新入口） |

| 区域 | 事实源 | 为什么它是正确的事实源 |
| --- | --- | --- |
| todo | `AgentTodoService`（引擎，durable） | 面板必须显示**引擎认定**的列表：播种（plan）、undo、压缩摘要都写它；模型看到的就是它 |
| updates | `NotifyUser` 工具 + 子代理生命周期事件 | 这是"模型主动告诉用户"的语义，只有工具调用能表达；不是引擎状态 |
| approval | `ApprovalController`（反向 RPC） | 审批是**一次性交互**，不是可枚举的状态；有请求才有面板 |

所以需求的表述要精确：**不是"三个来源合成一个"，而是"三个事实源各自保留，但交付通道、容器能力、生命周期、键盘鼠标 i18n 全部统一"**。当前代码的问题恰恰是第二列（delivery）有四种，而不是第一列有三个。

## 2. 推送通道设计（R1、D-1）

### 2.1 新增事件

```ts
// packages/agent-core-v2/src/features/todo/todoOps.ts
export const TODO_UPDATED_EVENT_TYPE = 'todo.updated' as const;

const todoUpdatedSchema = z.object({
  agentId: z.string(),
  todos: z.array(TodoItemSchema),   // 全字段：id/parentId/kind/title/status/progress/description
  rev: z.number(),                  // 单调递增，供 UI 丢弃乱序/重复
});

export class TodoUpdated extends AgentEvent2<z.infer<typeof todoUpdatedSchema>> {
  static override readonly type = TODO_UPDATED_EVENT_TYPE;
  static override readonly observable = true;   // ← 关键：进 IEventBus
  static override readonly durable = false;     // ← 关键：不产生第二条 wire 记录
  static override readonly schema = todoUpdatedSchema;
}
export interface TodoUpdated extends z.infer<typeof todoUpdatedSchema> {}
registerEvent2Class(TodoUpdated);
```

**`durable = false` 是必须的**：`ToolsUpdateStore` 已经负责落盘（`todoOps.ts:16-19`、`replayBuilder/fold.ts:186`）。若新事件也标 durable，同一份状态会写两条 wire 记录，`replayBuilder` 与 `transcript` 的折叠逻辑重复消费，且 `FOLD_CARRYOVER_WIRE_TYPES` 出现冗余项。`observable = true` + `durable = false` 在仓库里已有先例语义（`eventDispatcherService.ts:623-633`：两条判断彼此独立）。

**`registerEvent2Class` 对非 durable 事件直接返回**（`event2.ts:71-73`），因此不需要 schema 校验注册——但 schema 仍要写，供客户端侧类型与未来 durable 化。

### 2.2 发布点

```ts
// packages/agent-core-v2/src/features/todo/todoService.ts
private async commit(todos: readonly TodoItem[]): Promise<void> {
  await this.actor.dispatch(new ToolsUpdateStore({ agentId, key: 'todo', value: todos }));
}

replace(todos) { this.actor.send({ type: 'todo.used' }); return this.commit(todos); }
clear()        { this.actor.send({ type: 'todo.used' }); return this.commit([]); }
```

发布必须在 `ToolsUpdateStore` **之后**，且用 actor 的 `dispatch`（同一个 `IEventDispatcher`，保证 `agentId` 上下文校验通过，`eventDispatcherService.ts:505-515`）。两次 dispatch 的顺序由 dispatcher 的队列保证（`dispatching` 标志 + `queue`，`eventDispatcherService.ts:516-520`）。

`rev` 由服务内部自增（`private rev = 0`），不做持久化——它的唯一作用是让 UI 丢弃"重连后旧快照覆盖新推送"这类乱序。恢复路径的权威值仍来自 `toolStore['todo']`（F9）。

### 2.3 三层登记清单

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `agent-core-v2/src/features/todo/todoOps.ts` | 新事件类 + payload interface |
| 2 | `agent-core-v2/src/features/todo/todoService.ts` | 发布点 |
| 3 | `agent-core-v2/src/events.ts` | `AgentEvent` 联合加一项 + 导出类型 |
| 4 | `node-sdk/src/events.ts` | `export type { TodoUpdatedEvent }` |
| 5 | `node-sdk/src/v2/event-mapper.ts` | **不改**（丢弃名单模式，非列出即透传，F8） |

`event-mapper.ts` 的 `translateDomainEvent` 会 `Object.assign({}, event, { type, sessionId, agentId })`——`TodoUpdated` 自身已带 `agentId`，与 `AgentDomainTrait` 一致，无需特殊处理。**验证点**：确认 `AgentEvent2` 的 `agentDomain = true` 不会让 `Event2` 的 `serialize()` 把 `agentId` 当普通字段重复写（看 §7 的测试项）。

### 2.4 被否决的通道方案

| 方案 | 否决理由 |
| --- | --- |
| 把 `ToolsUpdateStore` 标 `observable` | 它现在承载"任意 tool store 键"的通用语义（`key: string`），把它推给客户端等于把一个内部 KV 事件变成客户端 API；将来新增其他 key 会泄漏到 SDK 事件流 |
| UI 侧统一走 `getTodos()` 拉取 | 需要 UI 判断"何时拉"——正是当前 bug 的成因（谁触发谁决定）。且恢复路径已经有完整快照，再拉一次是重复通道 |
| 复用 `toolStore` 的 wire 记录做推送 | wire 是文件 I/O，不广播 |

## 3. 容器与区域契约（R3、R5）

### 3.1 文件布局

```
apps/kimi-code/src/tui/components/chrome/status-surface/
  index.ts              — StatusSurfaceComponent（容器）
  region.ts             — StatusRegion 接口 + 能力判定纯函数
  budget.ts             — 唯一高度预算实现 + 常量
  region-frame.ts       — 区域外框/标题/提示行（原 formatHiddenCounts 等迁入）
  regions/
    approval-region.ts  — 包装 ApprovalPanelComponent
    todo-region.ts      — 包装 TodoPanelComponent
    updates-region.ts   — 包装 NotifyPanelComponent
apps/kimi-code/src/tui/controllers/status-surface.ts
                        — StatusSurfaceController（取代 NotifyController 的挂载职责）
```

原文件**保留**（`todo-panel.ts` / `notify-panel.ts` / `approval-panel.ts`），本轮只把它们降级为"区域实现"，不重写内部渲染逻辑——把结构风险与渲染风险分开。

### 3.2 `StatusRegion` 接口

```ts
// region.ts
export interface RegionRenderContext {
  readonly width: number;
  /** 容器分配给我的行数上限（含我自己的边框与提示行）。 */
  readonly budget: number;
  /** 当前焦点是否在我这里。 */
  readonly focused: boolean;
  /** 点击命中帧（容器在 render 时记录，供下一次鼠标事件使用）。 */
  readonly hit: RegionHit;
}

export interface StatusRegion {
  readonly id: RegionId;
  /** 越小越靠上；阻塞型区域用负值。 */
  readonly priority: number;

  isEmpty(): boolean;
  /** 理想总行数（含自身边框），容器据此分配。 */
  measure(width: number): number;
  render(ctx: RegionRenderContext): string[];

  /** 展开/折叠能力（三区域都必须实现，见 R5）。 */
  isExpanded(): boolean;
  setExpanded(expanded: boolean): void;
  /** 折叠是否会隐藏内容——点击折叠与 Ctrl+T 的判定都走它。 */
  hasHiddenContent(): boolean;

  /** 键盘（焦点在我这里时才收到）。返回 true 表示已消费。 */
  handleKey?(key: RegionKey): boolean;
  /** 鼠标（坐标已相对本区域左上角）。 */
  handleMouse?(event: RegionMouseEvent): RegionMouseResult | undefined;
  /** 容器需要知道我是否想拿焦点（点击时）。 */
  wantsFocus?(event: RegionMouseEvent): boolean;
}

export type RegionId = 'approval' | 'todo' | 'updates';
export type RegionKey = 'left' | 'right' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'enter' | 'escape' | 'toggle';
```

### 3.3 高度预算（唯一实现）

```ts
// budget.ts
export const STATUS_SURFACE_MAX_ROWS = 20;
export const STATUS_SURFACE_MIN_BODY_ROWS = 1;

export interface SurfaceBudget {
  readonly total: number;
  readonly perRegion: ReadonlyMap<RegionId, number>;
  readonly chromeRows: number;
}

export function computeBudget(
  rows: number,
  regions: readonly StatusRegion[],
  width: number,
): SurfaceBudget {
  const safeRows = Number.isFinite(rows) && rows > 0 ? rows : STATUS_SURFACE_MAX_ROWS;
  const total = Math.max(STATUS_SURFACE_MIN_BODY_ROWS, Math.min(STATUS_SURFACE_MAX_ROWS, Math.floor(safeRows / 2)));
  const chromeRows = regions.length > 1 ? regions.length - 1 : 0;   // 区域间分隔线
  let remaining = total - chromeRows;
  const perRegion = new Map<RegionId, number>();
  // 优先级高（priority 小）的先拿满，剩下的按比例分给后续区域
  for (const region of [...regions].sort((a, b) => a.priority - b.priority)) {
    const want = region.measure(width);
    const granted = Math.max(1, Math.min(want, remaining));
    perRegion.set(region.id, granted);
    remaining -= granted;
    if (remaining <= 0) {
      for (const rest of regions) if (!perRegion.has(rest.id)) perRegion.set(rest.id, 0);
      break;
    }
  }
  return { total, perRegion, chromeRows };
}
```

要点：

- `terminalRows` 只在这里读一次（`StatusSurfaceComponent` 构造时注入 `() => terminal.rows`），区域不再持有它（消除 F11）。
- `STATUS_SURFACE_MAX_ROWS` 同时是 `tui-state.ts` dock 上限的来源（`maxSize: STATUS_SURFACE_MAX_ROWS`），消除 F12 的手工对齐。
- **单调性**：`floor(rows/2)` 单调不减，`min` 与 `max` 保序 → 容器总行数随 `rows` 单调不减。

### 3.4 焦点模型

容器持有一个 `focusedRegionId: RegionId | null`：

- `Ctrl+N` → 在 `updates` 与 `null` 之间切换（保留既有语义，F15）。
- `Ctrl+T` → 若 `todo` 有隐藏内容则折叠/展开（不再需要 `hasOverflow()`，见 §3.5）。
- 点击区域 → 该区域 `wantsFocus()` 为真则夺焦，否则只做折叠/展开。
- `Esc` → 焦点置 `null`（回到编辑器）。
- **审批出现时**：`approval` region 自动夺焦（阻塞型），审批结束后焦点回到 `null`，编辑器拿回输入。

### 3.5 消除 T3（`hasOverflow` 与渲染不一致）

`TodoPanelComponent.hasOverflow()`（`todo-panel.ts:341-344`）是"条目数 > 5"，与"折叠态渲染行数"无关。新契约用**可测量**的定义：

```ts
hasHiddenContent(): boolean {
  // 折叠渲染 vs 展开渲染的实际行数差，而不是条目数启发式
  return this.renderCollapsedLines(this.width) < this.renderExpandedLines(this.width);
}
```

对树形模式：折叠态只画活动里程碑的 4 个子项，展开态画全部 → 2/3/4/5 项时差为正，Ctrl+T 因此生效。

**取舍**：该判定需要一次测量渲染，代价是一次 `render()` 调用（不写终端）。为控制开销，容器在 `render()` 时记录每个区域的 `collapsedLines` / `expandedLines`，`hasHiddenContent()` 读缓存；缓存未命中（首次按键早于首帧）则退化为 `todos.length > MAX_VISIBLE`——**但退化分支只用于"还没画过"的窗口，不再作为长期语义**。

### 3.6 区域堆叠与审批行内化的渲染形态

```
──────────────────────────────────────────────────────────────
  ▶ 审批  Bash  rm -rf node_modules      [1 允许] [2 会话] [3 拒绝]   ← approval region（阻塞）
──────────────────────────────────────────────────────────────
  Todo   3/8 · 37%      ▍▍▍▍▍░░░░░░░░
  ◆ 调研（2/3）  ◆ 实现（1/2）                                     ← todo region
──────────────────────────────────────────────────────────────
  Updates  1/3  · explore  · main           ← updates region
──────────────────────────────────────────────────────────────
  ┌ 输入框（保持挂载，提交被阻塞） ────────────────────────────┐
```

- **approval region 折叠态**：一行摘要（工具名 + 动作 + 选项编号），完整内容靠 Ctrl+O 展开或 Ctrl+E 全屏预览。
- **approval region 展开态**：受预算裁剪的主体（display blocks）+ choices + 键位提示。
- 审批的 choices **在折叠态也必须可见**（否则用户无法单键响应）。

### 3.7 审批行内化要改动的既有耦合（F17、F19）

| 位置 | 现状 | 改后 |
| --- | --- | --- |
| `dialog-host.ts:293-321` | `showApprovalPanel` → `mountEditorReplacement` | `statusSurfaceController.showApproval(payload)` |
| `editorReplacementMounted` | 审批置 `true` | 审批**不再**置位；其余 5 处 `mountEditorReplacement` 调用不受影响 |
| `resolve.ts:151` | 读 `editorReplacementMounted` | 读 `state.statusSurface.hasBlockingRegion()` |
| `survey-controller.ts:522` | 读 `editorReplacementMounted` | 同上 |
| `types.ts:322` `livePane.pendingApproval` | 审批状态载体 | 保留，供 `patchLivePane` 与 activity/survey 门禁复用（F19），但**面板渲染不再依赖它** |
| `activity-pane.ts:168` | `pendingApproval → hidden` | 不变（行为一致） |
| `kimi-tui.ts:440-455` | reverse-rpc hooks 直接调 dialogController | 改调 `statusSurfaceController`（question 仍走 dialog，不变） |

**提交阻塞（D2）**：推荐**软阻塞**——`message-dispatch.ts` 的提交入口在 `hasBlockingRegion()` 为真时把输入排队并提示，而不是禁用按键。理由：硬阻塞需要在 6 个键盘入口加判断，软阻塞只有一处，且用户输入不丢。

## 4. 使用集合与生命周期

### 4.1 生命周期归属

| 时机 | 动作 |
| --- | --- |
| 会话建立 | `StatusSurfaceController.attach(session)`；订阅 R1 事件 |
| 会话切走 | 清空三个区域（`reset()`），`focusedRegionId = null` |
| 会话恢复 | `hydrateTodo(toolStore['todo'])` 走**与实时路径相同的** `todoRegion.setTodos()` |
| 工具调用 result | updates region 的既有逻辑不变（result-gated），approval region 不变 |
| 回合结束 | updates region `setEnded(true)`（既有语义） |

`NotifyController` 的挂载职责迁到 `StatusSurfaceController`，其**投影逻辑**（pending/settled/turn 边界）保持不动——把"算数据"与"放面板"分开。`SessionEventHandler` 不再私有持有面板控制器（F4 的结构性问题）。

### 4.2 唯一更新入口

```ts
// controllers/status-surface.ts
applyTodo(todos: readonly TodoItem[], rev: number): void;      // 来自 R1 事件 / 恢复快照
applyUpdates(entry: NotifyEntry): void;                        // 来自 NotifyController
applyApproval(payload: ApprovalPanelData): void;               // 来自 reverse-rpc
clearRegion(id: RegionId): void;
```

四条路径（实时 / 恢复 / undo / 播种）最终都落到 `applyTodo`，消除 T1/T2/T4 的"多入口"成因。

## 5. i18n 收敛（R8）

新增 `tui.statusSurface.*`，键形如：

```
tui.statusSurface.header.todo / .updates / .approval
tui.statusSurface.hint.expand / .collapse / .scroll / .focus / .blur
tui.statusSurface.updates.count_one / .count_other
tui.statusSurface.updates.delegatedOne / .delegatedSwarm
tui.statusSurface.approval.blockedInput
```

迁移策略：**一次性改名**（不做双 key 并存）。`tui.approvalPanel.*` 与 `tui.dialogs.approvalPanel.*` 的内容并入 `tui.statusSurface.approval.*`，同时把 `approval-panel.ts:350` 的裸标题（`▶ ${title}`）与 `412-421` 的提示行改为 `t()`。

## 6. 改动清单（按文件）

| 文件 | 改什么 | 风险 |
| --- | --- | --- |
| `agent-core-v2/src/features/todo/todoOps.ts` | `TodoUpdated` 事件 | 低（新增） |
| `agent-core-v2/src/features/todo/todoService.ts` | 发布点 + rev | 低 |
| `agent-core-v2/src/events.ts` | 联合 + 导出 | 低（改一处漏一处会被 typecheck 抓到） |
| `node-sdk/src/events.ts` | re-export | 低 |
| `node-sdk/src/sdk-rpc-client-v2.ts` | `getTodos()` 返回全字段 | **中**（`SessionTodoItem` 是公开类型，需看是否破坏兼容；建议**加字段不删**） |
| `apps/kimi-code/src/tui/components/chrome/status-surface/**` | 新模块 | 中（新代码） |
| `apps/kimi-code/src/tui/controllers/status-surface.ts` | 新控制器 | 中 |
| `tui-state.ts` | `panelsRow` → `statusSurface` | 中 |
| `kimi-tui.ts` | 挂载、键盘路由、reverse-rpc hooks | **高**（多处） |
| `editor-keyboard.ts` / `custom-editor.ts` | 三个回调合一个 | 中 |
| `dialog-host.ts` | 审批改道 + `editorReplacementMounted` 语义 | **高** |
| `resolve.ts` / `survey-controller.ts` | 门禁改读新标志 | 中 |
| `reverse-rpc/approval/adapter.ts` | `todo_list → todo` 映射（顺带修 F16 命名空间） | 低 |
| `controllers/notify.ts` | 拆出投影/挂载 | 中 |
| `session-event-handler.ts` | 删工具参数投影、改调 applyTodo | 中 |
| `commands/undo.ts` | 删 `refreshTodoPanel` | 低 |
| `session-replay.ts` | 改走 applyTodo | 低 |
| 测试 | 见 `tasks.md` | — |

## 7. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| **A. 保留并排分栏，只抽公共基类** | 分栏下任一区域过长都会挤压另一个；高度预算无法只写一份（每个区域仍要按自己分到的宽度重算）。而且审批是阻塞型，与"信息面板并排"的语义不匹配 |
| **B. 把审批硬塞进现有 `panelsRow` 的第三列** | 三列在 80 列终端下每列 ~26 列，Markdown 与 diff 完全不可读。审批需要的是"整行宽度" |
| **C. 用一个"消息总线"把三个区域的事件都投进同一个队列** | updates 是跨 agent 通道化（每代理一个 tab），todo 是单列表，审批是一次性交互——三者的"条目"语义不同，强行同构会让 region 里塞满特例 |
| **D. 让区域各自读 `terminal.rows`（现状）** | 各自算预算 = N 份预算互相不知道对方占了多少 → 溢出或饥饿 |
| **E. 把审批保持编辑器替换，只统一另外两个** | 用户明确要求三个一起统一；且 `editorReplacementMounted` 的语义分叉会长期存在 |
| **F. 新事件标 `durable = true`，删掉 `ToolsUpdateStore`** | 会破坏 wire 兼容（历史会话的 `tools.update_store` 记录仍在）、`replayBuilder`/`transcript` 的折叠、以及 migration-legacy 的既有假设 |

## 8. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 审批行内化后，`editorReplacementMounted` 的 3 个消费者行为漂移 | 新增 `statusSurface.hasBlockingRegion()` 作为唯一判定；先写测试固定现状行为，再改 |
| 双事件（wire + observable）顺序不一致 | 同一个 `IEventDispatcher` 顺序派发；UI 用 `rev` 兜底丢弃旧值 |
| 容器渲染开销（每次 render 都要 measure 各区域） | 复用 `TodoPanelComponent` / `NotifyPanelComponent` 现有的"render 时记录行数"模式；容器不额外渲染两次 |
| `SessionTodoItem` 加字段破坏 SDK 兼容 | 只加不删；`SessionTodoStatus` 保持；新增字段全 optional |
| 高度预算改动导致终端渲染抖动 | `tasks.md` 里的单调性测试覆盖 4..60 行；dock 上限从同一常量导出 |
| 非 TUI 客户端（web/vscode）意外收到新事件 | 新事件是**增量**：现有客户端的 `switch (event.type)` 都有 `default` 分支忽略未知类型；在本轮不要求它们消费 |
