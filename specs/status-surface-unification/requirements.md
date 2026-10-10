# Requirements — 输入框上方提示栏统一为单一「状态栏」模块

## 目标

把输入框（editor）上方那一条提示区域，从**三个各自挂载、各自取数、各自处理键盘与高度的组件**，收敛成**一个模块**：`StatusSurface`。

模块拥有：

- **一个容器**，独占编辑框上方那一行（desktop/regular）或 dock 中那一段（fullscreen）；
- **一个状态源**（引擎），UI 只消费推送；
- **一套公共能力**（展开折叠、高度预算、焦点、鼠标、i18n、滚动），区域只实现「我有什么内容」。

三个区域（region）：**todo**、**updates**、**approval**。审批从「替换编辑器」改为**行内 region**，与前两者共用同一个容器与同一套交互规则。

## 受众

维护 `apps/kimi-code/src/tui` 的界面开发者，以及维护 `packages/agent-core-v2` 中 todo / notify 领域与事件面的人。这份文档要回答：改哪些文件、以什么顺序、每步怎么验、哪些东西被有意排除。

## 背景：现状为什么是散的（既有事实）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | 两个面板并排塞在 `panelsRow`（`HStack`，grow 1:2），空则各自退出该行 | `tui-state.ts:154-180` |
| F2 | 审批**不在**这条栏里：`mountEditorReplacement()` 把输入框整个换掉 | `dialog-host.ts:107-113`、`kimi-tui.ts:440-455` |
| F3 | todo 面板的数据来自**工具调用原始参数**，不是引擎状态 | `session-event-handler.ts:861-863` |
| F4 | updates 面板的数据来自 `NotifyUser` 的工具**结果**（result-gated），控制器由 `SessionEventHandler` 私有持有 | `controllers/notify.ts:105-235`、`session-event-handler.ts:185` |
| F5 | 审批数据来自反向 RPC，经 `modal-coordinator` 排队 | `reverse-rpc/index.ts:30-46` |
| F6 | todo 状态在引擎侧已有唯一写入口，且**已持久化在 wire**：`AgentTodoService.replace/clear → ToolsUpdateStore` | `todoService.ts:152-172` |
| F7 | `ToolsUpdateStore` 只标 `durable`，**未标 `observable`**，因此不进 agent `IEventBus` | `todoOps.ts:16-27`、`eventDispatcherService.ts:631` |
| F8 | SDK 事件流 = agent `IEventBus` → `translateDomainEvent()`（**丢弃名单**模式，未列出的类型自动透传）→ `receiveEvent` | `session-wiring.ts:160-172`、`v2/event-mapper.ts:22-70` |
| F9 | `replayBuilder` 已把 `tools.update_store` 折进 `toolStore['todo']`，会话恢复路径据此还原面板 | `replayBuilder/fold.ts:186-187`、`session-replay.ts:161-175` |
| F10 | SDK 的 todo 读取面把 `TodoItem` 砍成 `{title,status}`——`/undo` 后刷新面板即丢失里程碑与进度 | `sdk-rpc-client-v2.ts:2014-2021`、`types.ts:407-410` |
| F11 | 三个面板的**高度预算各写一遍**，常量互不相干（todo 5/16/3、updates 12/5、queue 8） | `todo-panel.ts:47-57`、`notify-panel.ts:86-93`、`queue-pane.ts:24` |
| F12 | dock 另有一层静态上限（`panelsRow maxSize: 18`），与面板自算预算手工对齐 | `tui-state.ts:210-220` |
| F13 | 只有 `NotifyPanelComponent` 实现 `isExpanded()/hasHiddenContent()`；`TodoPanelComponent` 只有 `setExpanded()` | `notify-panel.ts:204-219` vs `todo-panel.ts:346-349` |
| F14 | 点击折叠只在 updates 容器上注册，todo 容器没有；fallback 还硬编码只看 notify 容器 | `kimi-tui.ts:435, 2402-2404` |
| F15 | 编辑器键盘把三个面板的键位**分别**接出来（Ctrl+T / Ctrl+N / Shift+↑↓） | `editor-keyboard.ts:339-360`、`custom-editor.ts:563-583` |
| F16 | 审批面板自带一套 i18n 命名空间（`tui.approvalPanel.*` vs `tui.dialogs.approvalPanel.*`），且已有硬编码中文残留 | `approval-panel.ts:350, 412-421`、`en.ts:970, 2719` |
| F17 | `editorReplacementMounted` 有 3 个消费者，改挂载方式必须同步 | `resolve.ts:151`、`survey-controller.ts:522`、`dialog-host.ts:108-116` |
| F18 | 审批摘要条带会把 5 个 display block 全量渲染，单 block 上限 10 行 → 长 diff 会很高 | `approval-panel.ts:42-43, 356-377` |
| F19 | `pendingApproval` 与 activity pane、survey 门禁耦合 | `types.ts:322`、`activity-pane.ts:168`、`survey-controller.ts:524` |
| F20 | 前一轮审计（`reports/todo-panel-module-audit.md`）已确认：T1 只读调用清空面板、T2 播种列表 UI 不可见、T3 树形 ≤5 项 Ctrl+T 失效、T4 `/undo` 丢字段、T5 同名标题重复渲染、T9 点击折叠缺失、U1 硬编码英文 | 见该报告第 1 节 |

## 范围

### 纳入

1. **一个容器**：新的 `StatusSurfaceComponent` 取代 `panelsRow`，持有区域列表、公共边框与滚动/焦点/鼠标/高度逻辑。
2. **唯一数据源**：todo 状态由引擎推送（见 R2），UI 不再从工具参数推断。审批与 updates 保持各自既有来源，但**统一经区域接口**进入容器。
3. **审批行内化**：审批成为容器内的一个 region，输入框保持可见可用；不再替换编辑器。
4. **公共能力抽成一份**：高度预算、展开折叠、焦点、鼠标命中、i18n 命名空间。
5. **消除 F20 的 T1/T2/T3/T4/T5/T9/U1 与 F10/F14/F15 的结构性成因**。
6. **`.agents/skills/write-tui/SKILL.md` 的「Where new features go」表格更新一条**：提示栏区域不再新增 `panelsRow` 兄弟节点，改为注册 region。

### 排除（本轮不做）

- **不改 `NotifyUser` 的 result-gating 语义**（updates 仍只在工具成功且返回 "displayed" 时上屏）。这是有意的产品语义，不是缺陷。
- **不改 `human/todo/` 死代码的处置**（审计 E1）。独立小改动，与本轮结构无关。
- **不改 `get()` 的写副作用**（审计 E2）。需要单独判断提醒语义，避免与 R1 的事件化互相干扰。
- **不做跨客户端（kimi-web / vscode / kap-server）的状态投影统一**。本轮只保证**新事件对它们是增量**、不破坏既有 wire 与 transcript。
- **不改 `SetTodoList` 这类遗留别名**。
- **不重做审批的 choices 生成策略**（策略链、`adaptChoices` 的判定逻辑保持不变）。
- **不引入主题新色**：边框复用 `border` / `borderFocus` / `primary`。

## 需求

### R1 — todo 状态从引擎推到 UI（唯一数据源）

新增一个 agent 域、`observable` 的领域事件（暂名 `todo.updated`），承载**完整 `TodoItem[]`**（`id/parentId/kind/title/status/progress/description`），由 `AgentTodoService.replace/clear` 在写入后发布。

- 事件必须与 `ToolsUpdateStore` 的持久化**并存**：wire 记录继续写（会话恢复依赖它，F9），新事件只负责实时推送。
- 新事件必须进入 SDK `Event` 联合，TUI 通过既有 `session.onEvent` 收。
- **验收**：`AgentTodoService.replace()` 之后，订阅 SDK 事件流的客户端能收到一条带全字段 todo 列表的事件；`tools.update_store` wire 记录仍按原样产生；`replayBuilder` 的 `toolStore['todo']` 仍可用。
- **验收**：非主代理（subagent）的 todo 写入事件带自己的 `agentId`，不与主代理混淆。

### R2 — 面板状态与引擎状态永远一致

UI 的 todo 区域**只**消费 R1 的事件流 + 会话恢复时的 `toolStore['todo']` 快照。

- **验收（原 T1）**：`TodoList` 只读调用（不带 `todos` 参数）后，todo 区域内容**不变**。
- **验收（原 T2）**：计划模式退出触发 `tryConvertPlanToTodos` 后，todo 区域**立刻**显示播种的里程碑树。
- **验收（原 T4）**：`/undo` 之后 todo 区域仍保留 `id/parentId/kind/progress`（保留层级与进度条）。

### R3 — 单一容器承载所有区域

`StatusSurfaceComponent` 是编辑框上方唯一挂载的组件。

- 内部区域按**固定优先级**排列：`approval` > `todo` > `updates`（越靠前越"阻塞"，需要用户先处理）。同一时刻可以多个并存。
- 垂直堆叠（不再左右分栏）。理由：分栏时任一区域过长都会挤压另一个；堆叠 + 统一高度预算更好控制。
- 容器负责：外框、区域间分隔、总高度预算、滚动兜底、快捷键提示行。
- **验收**：三个区域同时有内容时，只挂载一个组件；`state.panelsRow` 不再存在。

### R4 — 高度预算只写一份

- 容器持有唯一预算函数：`总行数 = min(MAX_TOTAL_ROWS, floor(terminalRows / 2))`，`每区域 = 总行数 − 容器开销 − 已占用`。
- 区域不再各自读 `terminalRows`；它们只回答「我理想需要多少行」。
- dock 的静态上限改为从容器导出的常量，消除手工对齐（F11/F12）。
- **验收**：`terminalRows` 从 4 扫到 60，容器渲染行数**单调不增**且恒 `≤ min(MAX_TOTAL_ROWS, floor(rows/2))`。
- **验收**：审批带一个 10 行 diff 时，容器总高度不超预算，且 diff 区域可滚动或提示折叠。

### R5 — 公共能力接口统一

抽出 `StatusRegion` 接口（`chrome/status-surface/region.ts`），至少包含：

```ts
interface StatusRegion {
  readonly id: 'approval' | 'todo' | 'updates';
  readonly priority: number;
  isEmpty(): boolean;
  /** 理想行数（不含容器边框），容器按预算裁剪。 */
  measure(width: number): number;
  render(width: number, budget: number): string[];
  isExpandable?(): boolean;
  isExpanded?(): boolean;
  setExpanded?(expanded: boolean): void;
  hasHiddenContent?(): boolean;
  /** 容器把未处理的鼠标事件按区域矩形转发。 */
  handleRegionMouse?(event: RegionMouseEvent): RegionMouseResult | undefined;
  /** 容器把键盘事件按焦点转发。 */
  handleRegionKey?(key: RegionKey): boolean;
}
```

- 折叠/展开、`hasHiddenContent`、`omitsExpandHint` 三个能力对三个区域**都**实现（消除 F13/F14）。
- 点击折叠由容器统一处理：点击区域空白 → 该区域折叠/展开。
- **验收（原 T9）**：点击 todo 区域与点击 updates 区域都能折叠/展开。
- **验收（原 T3）**：`isExpandable()` 的判定必须与「折叠态实际渲染行数 < 展开态行数」等价；树形列表 2/3/4/5/6 项时 Ctrl+T 全部生效。

### R6 — 键盘路由集中

编辑器只保留**一个**提示栏入口，由容器分发：

- `Ctrl+T`：todo 区域展开/折叠；
- `Ctrl+N`：updates 区域聚焦/失焦（保留既有语义）；
- `Shift+↑/↓`：滚动当前聚焦区域（或 todo 区域的展开视图，保留既有语义）；
- `Esc`：释放区域焦点（不吞掉编辑器的 Esc）。
- **验收**：`custom-editor.ts` 中不再出现 `onToggleTodoExpand` / `onPageNotify` / `onScrollTodo` 三个平行的回调，改为一个 `onStatusSurfaceKey`。
- **验收**：区域为空时按键照旧穿透给编辑器默认行为（不改变现有「无内容不消费按键」的规则）。

### R7 — 审批行内化，输入框保持可用

- 审批从 `mountEditorReplacement` 改为注册 `approval` region。
- 输入框**保持挂载**（用户可以在等待审批时继续打字），但**提交被阻塞**：提示条明确告知「审批处理中，输入会在处理后可发送」。
- 审批的焦点与键盘（↑↓ 选择、Enter 确认、数字快选、Esc 拒绝、Ctrl+E 预览、Ctrl+O 展开）**保持不变**，只是宿主从编辑器替换换成区域焦点。
- 全屏预览（`ApprovalPreviewViewer`）继续用现有的 screen takeover，不改。
- `editorReplacementMounted` 不再为审批置位；`resolve.ts:151` 与 `survey-controller.ts:522` 的语义改为读 `state.statusSurface.hasBlockingRegion()`。
- **验收**：审批出现时输入框仍渲染；审批解决后焦点回到编辑器且已输入内容保留。
- **验收**：审批出现时 activity pane 与 survey 的门禁行为与改造前一致（F19）。

### R8 — i18n 收敛

- 三区域共用 `tui.statusSurface.*` 命名空间；`tui.approvalPanel.*` 与 `tui.dialogs.approvalPanel.*` 合并进该命名空间（保留旧 key 的迁移映射或一次性改名，不长期并存两套）。
- **验收（原 U1）**：`Updates`、`update(s)`、`Delegated to …` 全部走 `t()`；中文界面下无英文残留。
- **验收**：`bun scripts/check-locale-keys.mjs` 通过。
- **新增校验**：在 `check-t-call-coverage`（或新增脚本）中，对 `components/chrome/status-surface/**` 与 `controllers/status-surface/**` 增加「禁止裸字符串字面量」检查，防止再退化。

### R9 — 数据来源收敛后，旧路径删除

- 删除 `session-event-handler.ts:861-863` 的工具参数投影；
- 删除 `commands/undo.ts` 的 `refreshTodoPanel()`（改为事件自然更新；`getTodos()` 的字段扩展仍需做，供非 TUI 客户端）；
- `session-replay.ts` 的 `hydrateTodoPanel()` 改为「走同一条区域更新入口」，与实时路径共用。
- **验收**：全仓库不存在「从 `TodoList` 工具参数读 todos 并喂面板」的代码。

## 开放决策（实施前需要确认）

| # | 决策 | 影响 |
| --- | --- | --- |
| D1 | 新事件的最终命名与是否同时把 `ToolsUpdateStore` 标为 observable | 只加新事件：语义清晰，但要保证两条路都写。两个都加：客户端可选择性消费，但同一事实有两个事件。**推荐只加新事件**（见 design D-1） |
| D2 | 行内审批的「阻塞提交」是软阻塞（提示 + 丢弃）还是硬阻塞（禁用提交键） | 影响 `message-dispatch.ts` 的入口判断 |
| D3 | 堆叠后是否保留「左右并排」作为窄终端下的回退 | 影响布局实现复杂度；**推荐不做**（窄终端下堆叠更可读） |

## 已有审计问题的对应关系

| 审计编号 | 本方案如何消除 |
| --- | --- |
| T1 只读调用清空面板 | R1+R2（面板不再读工具参数） |
| T2 播种列表不可见 | R1+R2（引擎写入即推送） |
| T3 树形 Ctrl+T 失效 | R5（能力判定与渲染行数等价） |
| T4 `/undo` 丢字段 | R2 验收 + `getTodos()` 字段扩展（R9） |
| T5 同名标题重复渲染 | R1 带来的全字段 id（UI 不再需要 title 兜底） |
| T9 点击折叠缺失 | R5（容器统一处理） |
| U1 硬编码英文 | R8 |
| A1 审批 todo 块不可达 | R3+R7 后该 display 块成为正常渲染路径之一；adapter 需补 `todo_list → todo` 映射 |
| E1 `human/todo/` 死代码 | 排除（独立改动） |
| E2 `get()` 写副作用 | 排除（需单独判断提醒语义） |
