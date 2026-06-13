# kimi-web P3 最终方案（goal / swarm / subagent / 激活徽标 / terminal / 视图分屏）

**目标：** 把 P3 定板设计落地到 kimi-web：子代理生命周期 + 内联卡、内联 swarm 卡、goal 常驻条、plan/goal/swarm 激活徽标、terminal 视图、tab 维度的 VSCode 式视图分屏。

**总体思路：** 绝大部分沿用既有「daemon 事件 → 投影器 `agentEventProjector` → reducer 状态 → Vue 组件」链路扩展；纯逻辑层（投影器 / reducer / 纯函数）配单测，Vue 组件以 `@vue/test-utils` 挂载测模板分支 + stub-daemon 浏览器实测。terminal 另起一条 WS 帧通道 + 引入 xterm.js。

**技术栈：** Vue 3 `<script setup>`、vitest、`@vue/test-utils`、`@xterm/xterm` + `@xterm/addon-fit`、现有 daemon REST/WS。

**spec 来源：** `reports/web-followups-design.md`（「P3 定板纪要」）+ `reports/web-p3-refined-mockup.html`。

**落地顺序（每块独立可发）：** ① 子代理投影+内联卡 → ② swarm 卡 → ③ goal 常驻条 → ④ 激活徽标 → ⑤ terminal tab → ⑥ 视图分屏。①是②④的数据基础，先做；P3-17 = ①②③④，P3-16 = ⑤⑥。

**统一验证（在 `apps/kimi-web` 下）：** `npx vitest run`、`npx vue-tsc --noEmit`、`npx oxlint src`；视觉/交互用 stub-daemon + 浏览器实测。

---

## ① /subagent 生命周期 + 内联 Agent / AgentGroup 卡片

**做什么：** 补齐子代理 `spawned→started→(suspended)→completed/failed` 全生命周期投影，并在转录里内联渲染（单个=可展开 Agent 卡，同一步 2+=AgentGroup 合并卡，参考 TUI `agent-group.ts` 与 mockup 第 4 节）。

**改动文件：**
- `src/api/types.ts` — AppTask 加子代理字段。
- `src/api/daemon/agentEventProjector.ts` — 扩展 `subagent.*` 投影；`subagent.started`/`subagent.suspended` 从「已知不投影」名单移入 `KNOWN_AGENT_CORE_TYPES`。
- `src/composables/messagesToTurns.ts` — 把同一步的子代理 toolUse 聚成 `agent`/`agentGroup` 块。
- `src/components/AgentCard.vue`（新建，单个）、`src/components/AgentGroup.vue`（新建，合并卡）。
- `src/components/ChatPane.vue` — `blk.kind === 'agent' | 'agentGroup'` 渲染上面两个组件。

**关键类型（AppTask 新增字段）：**

```ts
export interface AppTask {
  // …既有字段…
  /** 细粒度阶段，驱动 swarm/subagent 卡的 phase 文案；非 subagent 不设。 */
  subagentPhase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  subagentType?: string;          // general / coder …，来自 subagent.spawned
  suspendedReason?: string;       // 限流等
  swarmIndex?: number;            // 同一波并行下标，swarm 分组用
}
```

**投影器（`agentEventProjector.ts`）：** spawned 带齐 `subagentPhase:'queued'` + name/type/swarmIndex 并存入投影器内部 `subagentMeta: Map<id, AppTask>`；started → phase `working`；suspended → phase `suspended` + reason；completed/failed → `taskCompleted`。started/suspended 复用 reducer 既有的「`taskCreated` 对同 id 整体替换」做更新（因此从 Map 取回全量字段再覆盖 patch）。

```ts
case 'subagent.spawned': {
  const task = { id: p?.subagentId ?? ulid('task_'), sessionId, kind: 'subagent' as const,
    description: p?.subagentName ?? 'subagent', status: 'running' as const, subagentPhase: 'queued' as const,
    ...(typeof p?.subagentType === 'string' ? { subagentType: p.subagentType } : {}),
    ...(typeof p?.swarmIndex === 'number' ? { swarmIndex: p.swarmIndex } : {}),
    createdAt: new Date().toISOString() };
  s.subagentMeta.set(task.id, task);
  out.push({ type: 'taskCreated', sessionId, task });
  break;
}
case 'subagent.started':   out.push({ type:'taskCreated', sessionId, task: patchSubagent(s, p?.subagentId, { subagentPhase:'working', startedAt:new Date().toISOString() }) }); break;
case 'subagent.suspended': out.push({ type:'taskCreated', sessionId, task: patchSubagent(s, p?.subagentId, { subagentPhase:'suspended', suspendedReason: typeof p?.reason==='string'?p.reason:undefined }) }); break;
case 'subagent.completed': out.push({ type:'taskCompleted', sessionId, taskId: p?.subagentId ?? '', status:'completed', outputPreview: typeof p?.resultSummary==='string'?p.resultSummary:undefined }); break;
case 'subagent.failed':    out.push({ type:'taskCompleted', sessionId, taskId: p?.subagentId ?? '', status:'failed',    outputPreview: typeof p?.error==='string'?p.error:undefined }); break;
```

> 若觉得 Map 缓存 hacky，可改为新增 `{ type:'taskUpdated'; sessionId; taskId; patch: Partial<AppTask> }` 事件 + reducer 按 id 合并 patch。先用 Map，出问题再升级（YAGNI）。

**组件：** `messagesToTurns` 识别子代理 toolUse（toolName 为 agent 类 / 带 subagent 元数据）→ 连续多个聚成 `{kind:'agentGroup', members}`，单个 `{kind:'agent', member}`；member 的 phase 通过 toolCallId 关联到对应 AppTask。AgentCard / AgentGroup 结构和样式搬 mockup 的 `.agentcard` / `.agentgroup`。

**验证：** 单测 `test/subagent-lifecycle.test.ts`（投影 spawned→queued、started→working、suspended 带 reason、completed/failed）+ `test/agent-group-turns.test.ts`（`messagesToTurns` 把 2 个子代理聚成 agentGroup、1 个为 agent，携带 name/type/phase）；stub 注入同一步多个 subagent → 浏览器看内联合并卡随 phase 更新。

> **⚠ 展示位待你最终确认：** 这里按定板的「内联 AgentGroup」实现。若改回「tasks 面板分组」，只替换组件层（改 `TasksPane.vue` 按 `kind` 分组、渲染位置从转录移到 tasks tab），投影层不变。

---

## ② /swarm 内联 TUI 风格卡片（多列）

**做什么：** 把同一波（带 `swarmIndex`）子代理聚成一张内联在转录里的 SwarmCard：渐变标题 + 多列成员网格（名字·phase·braille 进度·摘要）+ 顶部计数；随事件原地更新，不切 tab。参考 TUI `agent-swarm-progress.ts` 与 mockup 的 `.swarm`。

**改动文件：**
- `src/composables/swarmGroups.ts`（新建，纯函数 `buildSwarmGroups(tasks): SwarmGroup[]`）。
- `src/components/SwarmCard.vue`（新建，props `group: SwarmGroup`）。
- `src/components/ChatPane.vue` — 转录尾部 `v-for="g in swarms"` 渲染 SwarmCard。
- `src/composables/useKimiWebClient.ts` — 暴露 `swarms` computed = `buildSwarmGroups(当前会话 tasks)`。

**关键纯函数：**

```ts
export interface SwarmMember { id: string; name: string; subagentType?: string; phase: NonNullable<AppTask['subagentPhase']>; }
export interface SwarmGroup  { members: SwarmMember[]; counts: Record<SwarmMember['phase'], number>; }

// kind==='subagent' && swarmIndex!=null → 按 swarmIndex 升序聚成一组；统计各 phase 计数。
export function buildSwarmGroups(tasks: AppTask[]): SwarmGroup[]
```

**组件：** SwarmCard 直接搬 mockup 的 `.swarm/.mcell/.mtop/.mbot`：多列 `grid-template-columns:repeat(auto-fill,minmax(216px,1fr))`、phase 文案用 TUI 同一套（Orchestrating/Prompting/Working/Suspended/Queued/Completed/Failed/Cancelled/Aborted）、SVG 对勾用 `<svg class="ico ok">`、进度条用「按 phase 给档位的 braille 条」近似（completed 填满变绿、failed 变红）。

**验证：** 单测 `test/swarm-groups.test.ts`（带 swarmIndex 的聚成一组并按 index 排序、统计 counts；无 swarmIndex 不归组）；stub 注入一波 subagent（带 swarmIndex）→ 浏览器看内联多列卡更新。

**风险：** 「同一波」边界——首版用 `swarmIndex != null` 即归一张卡；若一个会话先后跑两波，需再按 turn / spawn 批次二次分组（加 `parentToolCallId` 或 turn id 维度）。先做单波，代码注释标 TODO。

---

## ③ /goal 常驻条（可展开）

**做什么：** `goal.updated` → reducer `goalBySession` → dock 上方常驻条（折叠一行 / 点击展开完整卡，含目标全文 + 完成判据 + 预算条），complete 或 null 自动消失。参考 mockup 的 `.goalstrip/.goalexp`。

**改动文件：**
- `src/api/types.ts` — `AppGoal` 类型 + AppEvent `goalUpdated`。
- `src/api/daemon/eventReducer.ts` — state 加 `goalBySession`，新增 case。
- `src/api/daemon/agentEventProjector.ts` — `goal.updated` 从「已知不投影」移出，投成 `goalUpdated`。
- `src/components/GoalStrip.vue`（新建）。
- `src/components/ConversationPane.vue` — dock 里 QuestionCard/ApprovalCard/Composer 之上渲染 `<GoalStrip v-if="goal">`。
- `src/composables/useKimiWebClient.ts` — 暴露 `goal` computed = `goalBySession[activeSessionId]`。

**关键类型 / 事件：**

```ts
export interface AppGoal {
  goalId: string; objective: string; completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number; tokensUsed: number; wallClockMs: number;
  budget: { tokenBudget: number|null; remainingTokens: number|null; turnBudget: number|null; overBudget: boolean };
}
// AppEvent:
| { type: 'goalUpdated'; sessionId: string; goal: AppGoal | null }
```

**reducer：** `goalBySession: Record<string, AppGoal|null>`；`goalUpdated`：status 为 active/paused/blocked 存入，complete 或 `goal===null` 删键。**投影器：** `goal.updated` 把 `snapshot` 映射成 AppGoal；`snapshot===null` 或 `status==='complete'` → `{goal:null}`。

**组件：** GoalStrip 本地 `expanded` ref；折叠态 `▸ 目标 <objective截断> <进度条> 62% ⌄`，展开态 状态徽标 + objective 全文 + completionCriterion + `turnsUsed/tokensUsed` + 预算条。dock 高度变化已有 ResizeObserver 处理 follow-to-bottom，无需额外改。

**验证：** 单测 `test/goal-reducer.test.ts`（active 写入、complete/null 清除）；挂载测 `test/goal-strip.test.ts`（折叠/点击展开/complete 不渲染）；stub 注入 goal.updated → 浏览器看出现/展开/消失。

---

## ④ plan / goal / swarm 激活徽标（状态行）

**做什么：** 状态行加三个独立、可同时出现、可点击的徽标：`[plan]`（plan 模式）/ `[goal ● active · 4m · 7 turns]`（活跃目标）/ `[swarm ⟳ x/n]`（有 swarm 在跑）。参考 mockup 的 `.abadge` + TUI footer。**全部从既有状态派生，无新事件。**

**改动文件：**
- `src/composables/useKimiWebClient.ts` — 加 `activationBadges` computed。
- `src/components/Composer.vue`（或 ConversationPane 状态行所在）— 渲染三徽标。

**派生来源：** plan ← `rawState.planMode`；goal ← ③ 的 `goalBySession`；swarm ← ② 的 `buildSwarmGroups`（有任一组在跑）。

```ts
const activationBadges = computed(() => ({
  plan: rawState.planMode,
  goal: goal.value && goal.value.status !== 'complete'
    ? { status: goal.value.status, turnsUsed: goal.value.turnsUsed, elapsedMs: goal.value.wallClockMs } : null,
  swarm: swarms.value.length ? { done: doneCount(swarms.value), total: memberCount(swarms.value) } : null,
}));
```

**组件：** 样式搬 mockup `.abadge.plan/.goal/.swarm`；点击 goal → 展开 GoalStrip / 滚到它，点击 swarm → 滚到对应 SwarmCard。颜色走 token（plan/swarm 蓝、goal 绿）。

**验证：** 单测 `test/activation-badges.test.ts`（用既有 session-cache mock 模式注入 planMode / goal / swarm，断言 computed 输出）；浏览器看三徽标按状态独立出现、可点击。

---

## ⑤ Terminal 作为普通 tab（xterm + WS 通道）

**做什么：** chat/tasks/todo 同级加 `terminal` tab，跑通单个终端：REST 创建 + WS attach/input/resize/close + output/exit。后端已就绪（`packages/server/src/routes/terminals.ts` + `ws-control.ts` 的 `terminal_*` 帧，含 `since_seq` 重放）。

**改动文件：**
- `apps/kimi-web/package.json` — 加 `@xterm/xterm`、`@xterm/addon-fit`。
- `src/api/types.ts` — `AppTerminal` + KimiWebApi 方法签名。
- `src/api/daemon/client.ts` — `createTerminal/listTerminals/getTerminal/closeTerminal` + `connectEvents` 透传终端收发。
- `src/api/daemon/ws.ts` — `DaemonEventSocket` 发 `terminalAttach/Input/Resize/Detach/Close`；`handleFrame` 识别 `terminal_output`/`terminal_exit` → handler `onTerminalOutput(tid,data,seq)` / `onTerminalExit(tid,exitCode)`；`onServerHello` 后用记录的 `lastSeq` 重 attach。
- `src/composables/useTerminal.ts`（新建）— create→attach→流式；`onData`→input；fit→resize（防抖 100ms）；exit→只读 + 重开。
- `src/components/Terminal.vue`（新建）— xterm 容器 + FitAddon + ResizeObserver + 三套主题映射 xterm `ITheme`（跟随 `useIsDark`/data-theme）。
- `src/components/TabBar.vue`（加 terminal tab、`PaneKey` 扩枚举）、`ConversationPane.vue`（`active==='terminal'` 渲染 `<Terminal>`）。
- `apps/kimi-web/dev/stub-daemon.mjs` — 加假 pty（REST 返回假 terminal、WS 把 `terminal_input` 回显成 `terminal_output`），供本地演示。

**REST：** `POST/GET /sessions/{id}/terminals`、`GET .../{tid}`、`POST .../{tid}:close`。**WS 帧：** C→S `terminal_attach{session_id,terminal_id,since_seq?}` / `terminal_input{...,data}` / `terminal_resize{...,cols,rows}` / `terminal_detach` / `terminal_close`；S→C `terminal_output{seq,...,payload:{data}}` / `terminal_exit{...,payload:{exit_code}}`。

**验证：** 单测 `test/terminal-client.test.ts`（stub fetch 断言 REST 形状）、`test/terminal-ws.test.ts`（stub WebSocket 断言 attach 帧编码、output 按 terminal_id 分发、重连用 since_seq）；stub 假 pty → 浏览器实测输入/输出/resize/exit/重开。

**风险：** xterm 主题与三套 kimi 主题对齐；隐藏 tab 容器 0 尺寸 → 切到 terminal tab 时再 `fit()`；后台标签页 rAF 冻结（项目记忆）→ `since_seq` 重放保证切回前台补齐输出。

---

## ⑥ 视图分屏（tab/视图维度，VSCode 编辑器组）

**做什么（完全体）：** 会话区可任意横/竖劈成多个**视图组**，每组独立持有 chat/tasks/todo/files/terminal **之一**；可拖拽视图在组间移动、调分隔比例、布局持久化；窄屏退化单组整屏切。**不是**在 terminal 标签内部分屏。

> 这是 P3 最大、且要重构 ConversationPane 视图层的一块，**建议单独 spec 再细化**；此处给最终架构与拆分骨架。

**视图模型：** 把今天「ConversationPane 一个 active tab」升级为布局树：

```ts
type Group  = { id: string; views: PaneKey[]; active: PaneKey };
type Layout = { dir: 'row' | 'col'; children: (Layout | Group)[]; sizes: number[] } | Group;
```

单组即退化为今天的行为。

**改动文件：**
- `src/composables/usePaneLayout.ts`（新建，纯逻辑：split/close/move/resize 布局树操作 + 序列化到 localStorage `kimi-web.layout`，可单测）。
- `src/components/ViewGroup.vue`（新建，一条视图 tab 条 + 当前 view 内容插槽；view 内容复用现有 ChatPane/TasksPane/TodoCard/FileTree/Terminal）。
- `src/components/SplitLayout.vue`（新建，递归渲染布局树 + 分隔条拖拽，复用 `useResizable`/`ResizeHandle`）。
- `src/components/ConversationPane.vue` — 用 `<SplitLayout>` 替换单 active tab；`useIsMobile` 时强制单组。

**落地拆分（每块可单独 PR）：** ⑥a 布局数据模型 + 持久化（纯逻辑单测）→ ⑥b ViewGroup（先在单组模式跑通，等价今天的 tab）→ ⑥c SplitLayout（递归 + 分隔条拖拽 + 「向右/向下拆分」按钮）→ ⑥d ConversationPane 切换到 SplitLayout + 窄屏退化 → ⑥e（增强）HTML5 DnD 把视图在组间拖移。

**验证：** 单测 `test/use-pane-layout.test.ts`（split/move/resize/序列化）；浏览器实测把 chat 与 terminal 并排、拖拽调比例、刷新后布局还在、窄屏退化单组。

---

## 跨阶段风险 & 注意

- **投影器丢帧/重连**（和 P0-1 同源）：subagent/goal 事件若在重连窗口丢失，状态可能短暂不一致；快照恢复需带上 in-flight 的 goal/subagent 状态——若 daemon 快照未含，记为已知限制，待事件再次到达自愈。
- **组件测试边界**：本仓库单测主力是 composable/projector/reducer/纯函数；Vue 组件用 `@vue/test-utils` 挂载测「模板分支逻辑」，视觉/交互以 stub-daemon 浏览器实测为准（项目记忆：后台标签页 rAF 冻结、iframe 测移动端）。
- **stub-daemon 覆盖**：①②③④ 需 stub 能发 `subagent.*`/`goal.updated`；⑤需要假 pty + `terminal_*` 帧——这些 stub 路由要随代码一起加（项目记忆：跑旧 stub 会话会加载失败）。
- **主题三套**：新组件颜色一律走 token（`--blue/--ok/--soft/--mono`…），别硬编码；xterm 单独映射 `ITheme`。
