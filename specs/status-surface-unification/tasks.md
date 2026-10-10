# Tasks — 输入框上方提示栏统一为单一「状态栏」模块

设计见 `design.md`，需求见 `requirements.md`。

依赖关系：**T1–T3 是状态推送线**（T1→T2→T3 串行，其余任务的上游）；**T4–T6 是容器线**（T4→T5→T6）；**T7–T9 是审批线**（依赖 T5）；**T10–T12 是收尾**（依赖全部）。

全局验证命令（各任务验收在此基础上追加）：

```
cd packages/agent-core-v2 && bunx vitest run test/features/todo test/features/plan
cd apps/kimi-code && bunx vitest run test/tui/components/panels test/tui/controllers
bun scripts/check-no-comments.mjs
bun scripts/check-locale-keys.mjs
bun run typecheck
```

---

## T1 — 新增 `todo.updated` 领域事件（前置，其余状态线依赖）

新增 `TodoUpdated`：agent 域、`observable = true`、`durable = false`、携带**全字段** `todos` 与单调 `rev`。

**验收：**
- `packages/agent-core-v2/test/features/todo/todoUpdatedEvent.test.ts`：断言 `TodoUpdated.observable === true`、`TodoUpdated.durable === false`、schema 拒绝缺 `rev` 的 payload。
- `bun scripts/check-no-comments.mjs` → OK（agent-core-v2 是无注释区）。
- `bun run typecheck` 通过。

---

## T2 — 在 `AgentTodoService` 的写入路径发布事件

`replace()` / `clear()` 在 `ToolsUpdateStore` dispatch **之后**发布 `TodoUpdated`，`rev` 自增。

**验收：**
- `packages/agent-core-v2/test/features/todo/sessionTodo.test.ts` 扩展：`replace()` 后订阅 agent `IEventBus` 能收到一条 `todo.updated`，字段与传入值逐字段相等（含 `progress`、`parentId`、`kind`）。
- 同一测试断言 `replace()` 后 wire 中的 `tools.update_store` 记录**仍只有一条**（新事件不落盘）。
- 断言 `clear()` 发布 `todos: []`。
- 断言 `rev` 严格递增：连续三次写入得到 `rev = 1, 2, 3`。
- 断言子代理写入的事件 `agentId` 是自己的 id（复用既有 `isolates todos between agents` 用例的构造方式）。
- `bunx vitest run test/features/todo` → 全绿（既有 10 个用例不回归）。

---

## T3 — 事件接入 SDK 事件流

`agent-core-v2/src/events.ts` 加联合项与导出；`node-sdk/src/events.ts` re-export；确认 `event-mapper.ts` 无需改动。

**验收：**
- `bunx vitest run test/index.test.ts`（已有的 wire/事件面测试）不回归。
- 新增用例：`translateDomainEvent(new TodoUpdated({...}), 's1', 'main')` 返回的对象含 `type: 'todo.updated'`、`sessionId: 's1'`、`agentId: 'main'`、`todos`、`rev`。
- `bun run typecheck` 通过（联合项漏加会被 SDK 侧的 `Event` 使用点抓到）。
- 端到端：`apps/kimi-code/test/tui/controllers/status-surface-todo-sync.test.ts`（T10 会完善）临时断言 `session.onEvent` 能收到 `todo.updated`。

---

## T4 — 抽出公共能力契约与预算实现

新增 `components/chrome/status-surface/{region.ts,budget.ts,region-frame.ts}`，暂不接入任何现有面板。

**验收：**
- `apps/kimi-code/test/tui/components/panels/status-surface-budget.test.ts`：
  - `rows` 从 4 到 60 逐值，`computeBudget(...).total` **单调不减**且 ≤ `min(STATUS_SURFACE_MAX_ROWS, floor(rows/2))`。
  - `rows = 0` / `NaN` / 负数时退化为 `STATUS_SURFACE_MAX_ROWS`（不崩、不返回 0）。
  - 两个区域（want 各 20）在 `rows = 24` 时：`perRegion` 之和 + `chromeRows` **恰等于** `total`（无溢出、无空洞）。
  - 优先级顺序：`approval` 的 `want` 必须先被满足到 `min(want, remaining)`。
- 纯函数、无 TUIState 依赖（可被 `test/tui/utils` 风格直接调用）。

---

## T5 — `StatusSurfaceComponent` 容器

区域注册、排序、预算分配、分隔线、焦点、鼠标分发、`hasBlockingRegion()`。

**验收：**
- `apps/kimi-code/test/tui/components/panels/status-surface.test.ts`：
  - 零区域时 `render()` 返回 `[]`（不占行）。
  - 三区域同时有内容时容器只渲染一次总高度，且 `render()` 返回行数 `≤ computeBudget().total`。
  - 单区域时**不画**分隔线（`chromeRows === 0`）。
  - 点击区域空白 → 该区域 `setExpanded` 被调用一次（用假区域记录调用）。
  - `handleKey('toggle')` 在该区域 `hasHiddenContent()` 为假时返回 `false`（不消费按键，保持既有"无内容穿透"语义）。
  - `hasBlockingRegion()` 在 approval 区域非空时为 `true`。
- 行数预算：`terminalRows` 从 4 到 60，容器渲染行数 ≤ 预算且单调不减。

---

## T6 — 迁移 todo 与 updates 到区域

保留 `TodoPanelComponent` / `NotifyPanelComponent` 的内部渲染，外面套 region 适配器；`tui-state.ts` 用 `statusSurface` 取代 `panelsRow`；`kimi-tui.ts` 挂载点改一处（regular 与 fullscreen 两处都要改，`kimi-tui.ts:1155, 1195`）。

**验收：**
- 现有 `test/tui/components/panels/panels-row.test.ts` 删除或改写为 status-surface 的等价断言（"lone panel takes full width" → "single region gets full width"）。
- `test/tui/components/panels/dock-height-budget.test.ts` 改为从 `STATUS_SURFACE_MAX_ROWS` 取上限，且 4..60 行全通过。
- todo 区域：树形列表 2/3/4/5/6 项时 `hasHiddenContent()` 为真、Ctrl+T 生效（**原 T3 修复**）。用 `test/tui/components/panels/todo-panel.test.ts` 扩展，断言 `hasHiddenContent() === (collapsedLines < expandedLines)`。
- updates 区域：既有 41 个用例不回归。
- 点击 todo 区域可折叠/展开（**原 T9 修复**）：`test/tui/controllers/status-surface.test.ts`。
- `git grep panelsRow` 在 `apps/kimi-code/src` 下无结果。

---

## T7 — 键盘路由合并

`custom-editor.ts` 三个回调（`onToggleTodoExpand` / `onPageNotify` / `onScrollTodo`）合并为一个 `onStatusSurfaceKey(key)`；`editor-keyboard.ts` 相应改写；`kimi-tui.ts` 提供新 host 方法。

**验收：**
- `git grep -n "onToggleTodoExpand\|onPageNotify\|onScrollTodo"` 在 `apps/kimi-code/src` 下无结果。
- `test/tui/controllers/editor-keyboard.test.ts`：Ctrl+T / Ctrl+N / Shift+↑↓ 各自的消费与穿透行为与改造前逐条一致（先写测试固定现状，再改实现）。
- 区域为空时三组按键均穿透给编辑器默认行为。
- 焦点在 updates 时 `←/→/PgUp/PgDn/Esc` 行为不变（复用既有断言）。
- `bun run typecheck` 通过。

---

## T8 — 审批改为行内区域

`dialog-host.showApprovalPanel` 改调 `statusSurfaceController.applyApproval()`；`ApprovalPanelComponent` 包一层 region（折叠态一行摘要 + 选项编号，展开态受预算裁剪）；`ApprovalPreviewViewer` 不动。

**验收：**
- `test/tui/controllers/status-surface-approval.test.ts`：
  - 审批出现时 `editor` 仍在挂载树里（`state.editorContainer.children` 含 editor）。
  - 审批出现时 `editorReplacementMounted === false`。
  - 折叠态渲染行数 ≤ 2（一行摘要），且选项编号可见。
  - 展开态在 `terminalRows = 12` 时渲染行数 ≤ 预算，且内容可滚动。
  - 审批解决后 `hasBlockingRegion() === false`、焦点回到编辑器、编辑器已输入文本保留。
- `test/tui/components/panels/dock-height-budget.test.ts` 增加"审批 + todo + updates 同时存在"的高度用例（4..60 行）。
- `test/tui/controllers/approval-transcript.test.ts`（或既有对应测试）：审批的 transcript 条目行为不变（`transcript-renderer.ts:186-192` 的豁免清单不受影响）。

---

## T9 — `editorReplacementMounted` 语义收敛

`resolve.ts:151` 与 `survey-controller.ts:522` 改读 `statusSurface.hasBlockingRegion()`；`dialog-host.ts` 不再为审批置位。

**验收：**
- `test/tui/commands/resolve.test.ts`：审批进行中时 `resolve` 的行为与改造前一致（先固定现状测试）。
- `test/tui/controllers/survey-controller.test.ts`：`promptActive()` 在审批进行中返回 `true`。
- `git grep editorReplacementMounted` 只剩"其余 5 处 `mountEditorReplacement`"相关的赋值，不再有审批相关分支。

---

## T10 — 删除旧的多入口投影

- 删 `session-event-handler.ts:861-863` 的工具参数投影；
- 删 `commands/undo.ts` 的 `refreshTodoPanel()`；
- `session-replay.ts:161-175` 改为走 `statusSurface.applyTodo()`；
- `sdk-rpc-client-v2.ts` 的 `getTodos()` 扩展为全字段（**只加不删**）。

**验收：**
- **原 T1**：`test/tui/controllers/status-surface-sync.test.ts`：TodoList **只读**调用（`args = {}`）后 todo 区域内容不变。
- **原 T2**：模拟 `tryConvertPlanToTodos` 效果（直接 dispatch `TodoUpdated`）后区域内容等于播种列表。
- **原 T4**：`/undo` 后区域保留 `id/parentId/kind/progress`；`getTodos()` 返回含这些字段。
- `git grep -n "matchedCall.args" apps/kimi-code/src/tui/controllers/session-event-handler.ts` 中不再出现 todo 分支。
- `packages/node-sdk` 的公开类型 `SessionTodoItem` 只增字段，既有消费者（`apps/kimi-web`、`apps/vscode`）typecheck 通过。

---

## T11 — i18n 收敛

新增 `tui.statusSurface.*`；迁移 `tui.approvalPanel.*` 与 `tui.dialogs.approvalPanel.*`；修 `notify.ts` 的 `Delegated to …`、`notify-panel.ts` 的 `Updates` / `update(s)`。

**验收：**
- `bun scripts/check-locale-keys.mjs` 通过。
- `bun scripts/check-locale-placeholders.cjs` 通过。
- `bun scripts/check-t-call-coverage.mjs` 通过。
- 中文界面下手动/快照验证：updates 面板标题、折叠 stub、委派条目、审批标题与提示行**无英文残留**。
- `git grep -n "Delegated to\|' · Updates " apps/kimi-code/src` 无结果。

---

## T12 — 文档与校验脚本

- 更新 `.agents/skills/write-tui/SKILL.md` 的「Where new features go」：提示栏区域改为"注册 region"，不再新增 `panelsRow` 兄弟节点。
- 新增硬编码守卫：`scripts/check-status-surface-i18n.mjs`，扫描 `components/chrome/status-surface/**` 与 `controllers/status-surface.ts` 中的裸字符串字面量（排除 `t()` 参数、类型名、CSS 类样字符串）。

**验收：**
- 该脚本对当前代码返回 0；人为插入 `'hello'` 后返回 1（脚本自测）。
- `bun run lint` 通过。
- `bun run check:no-comments` 通过。

---

## 依赖图

```
T1 ─► T2 ─► T3 ──────────────────────────┐
                                          │
T4 ─► T5 ─► T6 ─► T7                      ├─► T10 ─► T11 ─► T12
              └─► T8 ─► T9 ──────────────┘
```

- T1–T3 与 T4–T6 **可并行**（不同包，无文件重叠）。
- T7 与 T8 都依赖 T6 的容器，但彼此无依赖，可并行。
- T10 必须在 T3 与 T6 之后（它同时删除旧投影并接新通道）。
- T11 在 T8 之后（审批的 i18n 命名空间此时才稳定）。
