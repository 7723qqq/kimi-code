# Progress — 输入框上方提示栏统一为单一「状态栏」模块

执行 `tasks.md`（T1–T12）。设计见 `design.md`，需求见 `requirements.md`。

**状态：T1–T12 全部完成。**

最终验证（全部在 `79e372319c` 之上、未提交）：

| 检查 | 结果 |
| --- | --- |
| `packages/agent-core-v2` typecheck | 通过 |
| `packages/node-sdk` typecheck | 通过 |
| `apps/kimi-code` typecheck | 通过 |
| `bun run lint` | `0 errors`（11320 warnings 为仓库既有） |
| `check-no-comments` | OK（2007 files，154 baseline） |
| `check:boundaries` / `check:deep-imports` | OK |
| `check-locale-keys` | 全部一致 |
| `check-locale-placeholders` | OK |
| `check-t-call-coverage` | 全部 t() 有对应 key |
| `check-status-surface-i18n`（新增） | OK（8 files），正反例双向验证 |
| `agent-core-v2` 全量 vitest | **7855 passed**（440 files） |
| `kimi-code` 全量 vitest | **4349 passed**（274 files，3 skipped） |
| `node-sdk` 全量 vitest | **274 passed**（28 files，1 todo） |

---

## T1 — `TodoUpdated` 领域事件 ✅

**交付：**
- `packages/agent-core-v2/src/features/todo/todoOps.ts`：`TodoUpdated`（`observable = true`、`durable = false`、payload 含 `agentId`/`todos`/`rev`）+ 纯 payload 接口 `TodoUpdatedEvent`（沿用 `GoalUpdated`/`GoalUpdatedEvent` 的双导出范式）。
- `packages/agent-core-v2/src/features/todo/todoItem.ts`：提取 `todoItemSchema`，让事件 schema 与 `TodoItem` 类型共享同一份字段定义。
- `packages/agent-core-v2/test/features/todo/todoUpdatedEvent.test.ts`：7 条用例。

**验收证据：** `bunx vitest run test/features/todo/todoUpdatedEvent.test.ts` → 7 passed（断言 `observable === true`、`durable === false`、schema 拒绝缺 `rev`、拒绝负/小数 `rev`、拒绝缺字段的 item）。

**为什么 `durable = false` 是必须的：** `ToolsUpdateStore` 已经负责落盘，且 `EVENT2_REGISTRY` 只登记 durable 事件、被 `stateContribution` 当作 wire 重放表使用。若新事件也标 durable，同一份状态会写两条记录并污染重放表。

---

## T2 — 发布点 ✅

**交付：** `AgentTodoService` 在 durable `commit` 回调里发布（见下方"与设计的偏差 1"）。

**验收证据：** `bunx vitest run test/features/todo` → 35 passed。覆盖：全字段往返（含 `progress`/`description`）、`clear()` 发空数组、**`todo.updated` 从不落 wire**（反向断言：3 条 `tools.update_store` 中 0 条新事件）、`rev` 严格递增、**子代理写入携带自己的 `agentId`**、**wire 重放（会话恢复）也发布**。

---

## T3 — SDK 事件流接入 ✅

**交付：** `agent-core-v2/src/events.ts` 加 import 与 `AgentEvent` 联合项；`index.ts` 导出 `todoOps`；`node-sdk/src/events.ts` re-export；`node-sdk/test/session-event-types.test.ts` 的**穷尽 switch** 加入 `'todo.updated'`（该测试会在 typecheck 阶段强制暴露任何漏登记）。

**`v2/event-mapper.ts` 未改动** —— 验证了 design 的假设：`DROPPED_DOMAIN_EVENT_TYPES` 是丢弃名单，非列出即透传。

**验收证据：** `bunx vitest run test/todo-updated-event.test.ts` → 3 passed（端到端：`translateDomainEvent` 返回对象含 `type`/`sessionId`/`agentId`/全字段 `todos`/`rev`；子代理 `agentId` 透传；空列表与缺失可区分）。

---

## T4 — 公共契约与预算 ✅

**交付：** `apps/kimi-code/src/tui/components/chrome/status-surface/{region.ts,budget.ts,region-frame.ts}`。

**验收证据：** `bunx vitest run test/tui/components/panels/status-surface-budget.test.ts` → 15 passed。覆盖：`rows` 4→200 时总预算 ≤ `min(20, floor(rows/2))` 且**单调不减**；`0`/负数/`NaN`/`Infinity` 退化为上限；`granted ≤ total` 全高度成立；优先级抢占（approval 先满足）；饥饿区域保留 `0` 值；空区域跳过。

---

## T5 — `StatusSurfaceComponent` 容器 ✅

**交付：** `status-surface/index.ts` —— 区域注册、按优先级排序、预算分配、焦点所有权、鼠标坐标平移、点击折叠。

**验收证据：** `bunx vitest run test/tui/components/panels/status-surface.test.ts` → 26 passed。覆盖：零区域不占行；全高度不超预算；区域自定界（容器不画多余横线）；优先级排序；超额请求被裁剪；`hasBlockingRegion()`；空区域不可聚焦；`autoFocus`；折叠幂等与"无隐藏内容不消费按键"；键只送到聚焦区域；Esc 释放焦点；鼠标坐标平移、点击折叠、点击夺焦优先、区域外忽略、首帧前忽略、wheel 分步；每区域每帧只 measure 一次。

---

## T6 — 迁移 todo 与 updates ✅

**交付：** `regions/todo-region.ts`、`regions/updates-region.ts`；面板新增 `setBudget()`（有预算用容器的，无预算沿用原终端推导，保持独立可用）；`NotifyPanelComponent.measureHeight()`；`tui-state.ts` 用 `statusSurface` + `statusSurfaceContainer` 取代 `panelsRow`（`maxSize` 改为从 `STATUS_SURFACE_MAX_ROWS` 导出）；`kimi-tui.ts` 两处挂载点；`streaming-ui` / `transcript-renderer` / `notify.ts` 改走区域。

**验收证据：** `bunx vitest run test/tui` → 全绿。`git grep panelsRow` 在 `apps/kimi-code/src` 无结果。`test/.../panels-row.test.ts` 改写为 `status-surface-regions.test.ts`（7 用例）。

**同时修掉审计 T3：** `TodoPanelComponent` 新增 `isExpanded()` / `hasHiddenContent()`，后者按"折叠态与展开态各自会画出的条目行数"计算，取代 `todos.length > MAX_VISIBLE` 这个与渲染无关的启发式。

---

## T7 — 键盘路由合并 ✅

**交付：** `custom-editor.ts` 的 `onToggleTodoExpand` / `onScrollTodo` / `onPageNotify` / `onNotifyPanelKey` **四个回调合并为 `onStatusSurfaceKey(key)`**（`StatusSurfaceKey = RegionKey | 'focus'`）；`editor-keyboard.ts` 单点接线；`kimi-tui.ts` 提供 `toggleStatusSurfaceFocus()` / `handleStatusSurfaceKey()`。

**验收证据：** `git grep -n "onToggleTodoExpand\|onPageNotify\|onScrollTodo\|onNotifyPanelKey"` 在 `apps/kimi-code/src` 无结果。既有语义断言全部保留并通过：Ctrl+T 消费、草稿不被改动、autocomplete 优先于区域、无内容时穿透编辑器默认绑定。

---

## T8 — 审批行内化 ✅

**交付：** `regions/approval-region.ts`（折叠态 1 行摘要 + **编号选项可见**；展开态受预算裁剪；`autoFocus` + `claimFocus`）；`dialog-host.showApprovalPanel/hideApprovalPanel` 改走区域，**不再 `mountEditorReplacement`**；`ApprovalPanelComponent` 新增 `selectChoice()` / `reject()` / `headerText()` / 公开 `choiceCount()`。

**验收证据：** `bunx vitest run test/tui/components/panels/status-surface-approval.test.ts` → 18 passed。覆盖：无请求时不占行；到达即夺键盘；折叠态恰 1 行且编号可见；6 行终端下长 diff 仍占 1 行；展开受预算裁剪（24 行终端 → 12 行）；方向键移动高亮；Enter/数字/Esc 应答；会话级选择原样透传；`requires_feedback` 的数字应答**不盲提交**（进入内联输入）；`/undo` 后区域清空；**审批期间编辑器仍在挂载树**。

**同时修掉审计 A1 的一部分：** 折叠态复用面板的工具专属标题（见"与设计的偏差 4"）。

---

## T9 — `editorReplacementMounted` 语义收敛 ✅

**交付：** `resolve.ts` 的 `canRestoreSubmittedInput` 与 `survey-controller` 的 `promptActive` 改读 `hasBlockingRegion()`，且**防御性读取**（见"与设计的偏差 3"）；审批不再置 `editorReplacementMounted`。

**验收证据：** `kimi-tui-message-flow.test.ts` 的审批用例改为断言 `approvalRegion` 非空 + `hasBlockingRegion() === true` + **`editorReplacementMounted === false`**；`survey-controller.test.ts` 127 passed；`goal.test.ts` 全部通过。

---

## T10 — 删除旧的多入口投影 ✅

**交付：**
- **删除** `session-event-handler.ts` 中"从 `TodoList` 工具参数读 todos 喂面板"（审计 T1 的根因）；
- 新增 `handleTodoUpdated()`，只消费引擎事件，忽略非主代理；
- **删除** `commands/undo.ts` 的 `refreshTodoPanel()` 轮询；
- `session-replay.ts` 的 `hydrateTodoPanel()` 改走 `todoRegion.setTodos()`。

**验收证据：** `session-event-handler-todo.test.ts` 改写为 4 条新契约用例（工具参数**完全不喂面板**的反向断言、全字段保留、空数组 = 清空、忽略其他代理）；`commands/undo.test.ts` 改写为断言**不再拉取 `getTodos`**。

---

## T11 — i18n 收敛 ✅

**交付：** 新增 `tui.chrome.statusSurface.*` 命名空间（中英）；4 处硬编码英文收进 locale：`notifyPanelPage`、`notifyPanelUpdateCount_one/_other`、`notifyPanelDelegatedTo`、`notifyPanelDelegatedSwarm`；折叠摘要不再自造文案（复用面板标题）。

**验收证据：** 三项 i18n 检查全过；`notify-panel` / `notify` controller / `kimi-tui-message-flow` 共 355 测试通过；`git grep "Delegated to"` 在 `src` 无结果。

---

## T12 — 文档与校验脚本 ✅

**交付：**
- `.agents/skills/write-tui/SKILL.md` 新增"编辑器上方一律注册为 region"的规约，明确禁止再挂兄弟面板并说明原因（预算/焦点/鼠标由 strip 独占）。
- 新增 `scripts/check-status-surface-i18n.mjs` + `package.json` 脚本 `check:status-surface-i18n` + CI lint 作业接入。

**验收证据：** 正例 `OK (8 files)`；**反例**（植入 `'this should be caught by the guard'`）报出 `notify.ts:25` 并退出码 1，随后还原。

---

## 与 `design.md` 的偏差（实施中发现的更优解或必要修正）

1. **发布点从 `replace`/`clear` 移到 durable 的 `commit` 回调。**
   design 写的是"在写入路径发布"。实施中发现 `/undo` 通过事件派发器的 `participant.commit(snapshot)` 恢复状态，**不经过 `replace`/`clear`** —— 按原方案实施会让 undo 后面板变旧（这正是原代码需要 `refreshTodoPanel()` 补丁的原因）。`commit` 回调被 write / undo / wire replay **三条路径共用**，因此成为真正的单一发布点，`refreshTodoPanel()` 得以安全删除。新增测试证明 wire 重放也会发布。

2. **空列表的首次发布被跳过。**
   `plan.test.ts` 的 wire/emit 快照测试在会话启动时捕获到一条空的 `todo.updated`。评估后认为这不是"该更新快照"，而是**不该发出噪声事件**：改为"若此前从未发布过且列表为空则跳过"。启动零事件；而"模型把列表清空"这一有意义的动作（此前已发布过）仍照常推送。快照文件因此**无需改动**。

3. **两处门禁改为防御性读取 `statusSurface?.hasBlockingRegion()`。**
   design 假设 `state.statusSurface` 始终存在。实施中 123 + 6 个既有测试因此抛异常——它们使用不含该字段的假 state。这不只是测试问题：部分宿主与早期启动确实可能没有这条栏。已改为可选链，"没有提示栏"与"没有阻塞区域"视为同一答案，并在注释中写明。

4. **折叠摘要复用面板的工具专属标题，而非自造泛化文案。**
   初版写成 `Approve {{tool}}?`，导致 `ExitPlanMode` 的专属提示（"Ready to build with this plan?"）在折叠态消失——同一审批两种形态两套说法。改为调用 `panel.headerText()`，消除第二套文案。

5. **容器不画分隔线，区域自定界。**
   design 由容器统一画规则。实施中发现：让 todo 区域剥掉自身横线后，**单个 todo 区域时整条提示栏上方没有任何分隔**（回归测试以可见宽度 35 捕获）。改为区域自定界（todo 面板开头横线、updates 盒子上边框、审批自带横线各司其职），`SurfaceBudget.chromeRows` 随之移除。

6. **`regions/` 子目录 + 薄适配器。**
   design 的目录结构保留；适配器最终比初稿更薄——不重复实现提示语，只提供 `measure`（成本模型）与折叠判定，渲染完全转发给既有面板。

7. **`StatusSurfaceKey` 类型。**
   在 `RegionKey` 之外新增条级键 `'focus'`（Ctrl+N 抢/放焦点），因为它没有区域级语义。

## 实施中被测试逼出的真实缺陷（均已修复）

| # | 缺陷 | 影响 |
| --- | --- | --- |
| 1 | `handleNumber` 按 0-based 取值 | 屏幕印 `2. Allow for session`，按 `2` 却返回 `rejected` |
| 2 | `setRegion` 的 `autoFocus` 只在注册瞬间检查 | 审批上屏却拿不到键盘（"看得见、按不动"）；新增 `claimFocus()` 由区域主动索取 |
| 3 | 焦点存在两份真相（面板 `focused` + surface `focusedRegionId`） | Ctrl+N 后面板边框高亮但 `[`/`]` 翻页无效；收敛为 surface 独占，`onFocus`/`onBlur` 镜像 |
| 4 | 折叠摘要用泛化文案 | `ExitPlanMode` 的专属提示在折叠态消失 |
| 5 | 容器统一画分隔线 + 区域剥线 | 单个 todo 区域时提示栏上方无分隔 |
| 6 | locale 键路径写成 `tui.statusSurface.*` | 实际层级是 `tui.chrome.statusSurface.*`（与 `todoPanel`/`footer` 同级） |
| 7 | `check-no-comments` 违规 | agent-core-v2 是无注释区，我在该包 `src`/`test` 写了 4 处注释 |
| 8 | 3 个未使用导入 | `bun run lint` 报 3 errors |

---

## 第二轮：把实施期的补丁改造成模块化实现

依据：`design.md` 的原始方案。逐条判定偏差清单，只改造**真正的补丁**，其余保持现状。行为不变，用既有测试兜底。

### 判定结果

| 项 | 判定 | 处理 |
| --- | --- | --- |
| 偏差 1 发布点放在 `commit` 回调 | 合理设计（比 design 更根本，三条路径共用） | 保持 |
| 偏差 2 跳过首次空发布 | **补丁**（意图表达不清） | 改造 |
| 偏差 3 门禁防御性读取 | **补丁**（为迁就假 state） | 改造，回到 design 直读 |
| 偏差 4 折叠摘要复用面板标题 | 合理设计 | 保持 |
| 偏差 5 区域自定界 | 合理设计 | 保持 |
| 偏差 6 薄适配器 | 合理设计 | 保持 |
| 偏差 7 `StatusSurfaceKey` | 合理设计 | 保持 |
| `budgetOverride` 预算覆盖 | **补丁**（两套预算来源并存） | 改造 |
| `claimFocus` 焦点时机修正 | **补丁**（与 `autoFocus`/`onRequestRender` 三重机制） | 改造 |
| `hasHiddenContent` 行数计算 | 谓词合理，**但实现与 render 各写一份可见行规则** | 改造 |
| `region-frame.ts` | **中间态残留**（4 个导出零引用） | 删除 |
| `index.ts` 公开方法 | **中间态残留**（6 个零引用） | 删除 |
| `hasOverflow()` | **中间态残留**（旧门禁的唯一消费者是它自己的测试） | 删除 |

### 改造内容

1. **预算收敛为单一来源**（回到 design §3.3）
   - 面板不再"预算覆盖"旧算术：`budgetOverride` → `budget`，两条来源共用 `bodyRowsFor()` / `terminalShare()`。
   - 两个面板都改了（`todo-panel.ts` 与 `notify-panel.ts`——后者第一轮遗漏）。

2. **`measure` 改为纯查询**
   - 原实现"改状态 → 渲染 → 还原"，异常会泄漏状态。
   - 新增 `TodoPanelComponent.measureRows()`、`NotifyPanelComponent.paint()`；`renderAt` 用 try/finally 保证状态不泄漏。

3. **三套回调收敛为一个信号**
   - 删除 `onRequestRender` + `onClaimFocus`（4 处闭包 + 1 处焦点索取）。
   - 改为 `StatusRegion.onChange`，由 `setRegion()` 安装；`claimFocus()` 并入私有 `handleRegionChange()`——**重绘与焦点判断由 surface 独断**。
   - 区域构造函数不再需要 options。

4. **门禁恢复直读**
   - `resolve.ts` / `survey-controller.ts` 改回 `state.statusSurface.hasBlockingRegion()`，删除 `blocksSubmission()` 包装与相关注释。
   - 真实成因是**两个测试 harness 的假 state 缺字段**，已在 harness 补上（真实 `TUIState` 一直有）。

5. **折叠谓词由渲染本身报告**
   - 删除 `visibleItemRows()`（与 `renderTree`/`renderFlat` 重复描述可见规则）。
   - 改为 `paint(width, expanded)` 在绘制时报告 `itemRows`，`hasHiddenContent()` 比较两个折叠状态的**实际绘制结果**。

6. **删除中间态残留**
   - `region-frame.ts` 整模块；`index.ts` 的 `separator()` / `focusHint()` / `get width` / `get palette` / `removeRegion()` / `getRegion()`（后两者本就零引用，`orderedRegions` 与 `scrollFocused` 降为 private）。
   - `hasOverflow()` 及其测试（改写为覆盖真实谓词的两个用例，含里程碑树场景）。

7. **`publish()` 守卫意图命名**
   - `lastPublished: TodoState | undefined` → `hasPublished: boolean`（原字段存整个数组却只用 `undefined` 判断）。
   - 已确认 `commit` 回调在**恢复/播种时也会触发**，所以守卫本身是必要的，不是补丁。

### 过程中的操作失误（如实记录）

- 为回退一次失败的重构，我对**未提交**的 `todo-panel.ts` 执行了 `git checkout`，导致 T6 对该文件的改动被还原。已全部重建（`setBudget` / `isExpanded` / `hasHiddenContent` / `visibleItemRows`），且重建版本直接采用了本次的收敛方案。
- 教训：未提交的工作不能用 `git checkout` 回退。

### 验证（第二轮结束时）

| 检查 | 结果 |
| --- | --- |
| `agent-core-v2` 全量 vitest | 7855 passed |
| `kimi-code` 全量 vitest | **4350 passed**（+1，新增里程碑树谓词用例） |
| `node-sdk` 全量 vitest | 274 passed |
| 三个包 typecheck | 通过 |
| `bun run lint` | 0 errors |
| `check-no-comments` / `check:boundaries` / `check:deep-imports` | OK |
| `check-locale-keys` / `check-locale-placeholders` / `check-t-call-coverage` | OK |
| `check-status-surface-i18n` | OK（7 files，少一个是因为删掉了 `region-frame.ts`） |

行为不变：改造前后 `kimi-code` 全量测试均通过，唯一数量变化来自新增的谓词用例。

---

## 第三轮：文档同步 + 由文档暴露的一个真实缺陷

### 文档同步（中英各两处）

改动涉及用户可见行为，但 `docs/` 里仍在描述旧形态：

- `docs/{en,zh}/reference/keyboard.md`
  - `Ctrl-T` 描述从"待办列表被截断时"改为"展开或折叠待办列表或待处理的审批提示（仅当折叠确实会显示或隐藏内容时生效）"——旧描述对应的是已删除的 `hasOverflow()` 语义。
  - 审批段落改为：提示栏内联、输入框保持挂载（已输入内容不丢失）、提交被暂缓、折叠态仍显示编号选项。
  - `Ctrl-E` / `Ctrl-O` 两行按实际行为修正（`Ctrl-E` 是打开全屏查看器，`Ctrl-O` 仍是切换其他工具输出）。
- `docs/{en,zh}/guides/interaction.md`
  - 审批流程段同步说明内联形态与提交暂缓。

核对后**无需改动**的两处：`themes.md` 的 `borderFocus`（该色仍用于审批）、`keyboard.md` 开头的分组名（分类标签）。
`Updates` 面板"12 行或半屏"的说法经核对**仍然准确**（独立挂载时 `MAX_VISIBLE_ROWS = 12` 未变）。

### 由文档暴露的真实缺陷（已修）

写文档时发现"`Ctrl-O` 可展开审批提示"这句话与代码不符，追查后确认是 **T8 遗留的缺口**：

- `ApprovalRegion.handleKey()` 实现了 `case 'toggle'`，surface 的 `handleKey()` 也确实会把 `toggle` 路由给**当前聚焦区域**（审批因 `autoFocus` 必然聚焦）。
- 但 `kimi-tui.toggleTodoPanelExpansion()` **硬编码调用 `statusSurface.toggleFold('todo')`**，绕过了 surface 自身的路由。
- 后果：**折叠态的审批提示没有任何按键能展开**。用户能看到编号选项并作答（`1`/`2`/`3`、`Enter` 可用），但无法展开查看 diff 或命令详情——这正是折叠态存在的意义之一。

**修法**：`toggleTodoPanelExpansion()` 改为 `statusSurface.handleKey('toggle')`，即"优先折叠当前聚焦区域，无聚焦或区域不认领时回落到待办列表"。

**新增回归测试**（`status-surface.test.ts`）：
- `folds the focused region in preference to the todo list`——审批聚焦时折叠键必须作用于审批。
- `falls back to the todo list when the focused region declines the key`——聚焦区域不认领时回落待办列表。

### 验证（第三轮结束时）

| 检查 | 结果 |
| --- | --- |
| `kimi-code` 全量 vitest | **4352 passed**（+2，为上述回归测试） |
| `agent-core-v2` 全量 vitest | 7855 passed |
| `node-sdk` 全量 vitest | 274 passed |
| 三个包 typecheck / `bun run lint` | 通过 / 0 errors |
| `check-no-comments` / `check:boundaries` / `check:deep-imports` | OK |
| `check-locale-keys` / `check-locale-placeholders` / `check-t-call-coverage` / `check-status-surface-i18n` | OK |
