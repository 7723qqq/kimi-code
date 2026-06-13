# kimi-web P3 实现计划（goal / swarm / subagent / 激活徽标 / terminal / 视图分屏）

> **For agentic workers:** 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 把 P3 定板设计落地到 kimi-web：子代理生命周期、内联 swarm 卡、goal 常驻条、plan/goal/swarm 激活徽标、terminal 视图、tab 维度的视图分屏。

**Architecture:** 大部分是「事件→投影器(`agentEventProjector`)→reducer 状态→Vue 组件」的既有链路扩展；纯逻辑层走 TDD 单测（projector/reducer/messagesToTurns 已有测试基建），Vue 组件用 `@vue/test-utils` 挂载测 + stub-daemon 浏览器实测。terminal 另起 WS 帧通道 + xterm.js。

**Tech Stack:** Vue 3 `<script setup>`、vitest、`@vue/test-utils`、`@xterm/xterm` + `@xterm/addon-fit`、现有 daemon REST/WS。

**spec 来源：** `reports/web-followups-design.md`（「P3 定板纪要」）+ `reports/web-p3-refined-mockup.html`。

**总顺序（每个 Phase 独立可发）：** Phase 1 子代理投影 → Phase 2 swarm 卡 → Phase 3 goal 常驻条 → Phase 4 激活徽标 → Phase 5 terminal tab → Phase 6 视图分屏。Phase 1 是 2/3/4 的数据基础，先做。

**执行前置：** 每个 Phase 开工前 `git switch -c feat/p3-<phase>` 或在 `feat/web` 上小步提交；每个 Task 末尾提交。验证命令统一在 `apps/kimi-web` 目录下：`npx vitest run`、`npx vue-tsc --noEmit`、`npx oxlint src`。

---

## Phase 1 · /subagent 生命周期投影 + tasks 面板分组

**为什么先做：** 纯投影/reducer/组件层，可单测、零交互争议；swarm（Phase 2）复用这里产出的子代理状态。

**现状：** `agentEventProjector.ts` 只把 `subagent.spawned/completed/failed` 映射成 `taskCreated/taskCompleted`，丢了 `subagent.started`、`subagent.suspended`、`subagentType`、`swarmIndex`、`runInBackground`。

### Task 1.1：扩展 AppTask 数据模型

**Files:**
- Modify: `apps/kimi-web/src/api/types.ts`（AppTask，~280-292）

- [ ] **Step 1：给 AppTask 加子代理字段**

```ts
export interface AppTask {
  id: string;
  sessionId: string;
  kind: 'subagent' | 'bash' | 'tool';
  description: string;
  status: AppTaskStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  outputPreview?: string;
  outputBytes?: number;
  outputLines?: string[];
  // —— 子代理专用 ——
  /** 细粒度阶段，驱动 swarm/subagent 卡的 phase 文案；非 subagent 不设。 */
  subagentPhase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  /** 子代理类型（general / coder …），来自 subagent.spawned。 */
  subagentType?: string;
  /** suspended 原因（如限流）。 */
  suspendedReason?: string;
  /** 同一波并行子代理的下标，用于 swarm 分组。 */
  swarmIndex?: number;
}
```

- [ ] **Step 2：`vue-tsc` 编译通过**

Run: `npx vue-tsc --noEmit`
Expected: 0 error。

- [ ] **Step 3：提交**

```bash
git add apps/kimi-web/src/api/types.ts
git commit -m "feat(web): add subagent lifecycle fields to AppTask"
```

### Task 1.2：投影 subagent 生命周期（TDD）

**Files:**
- Test: `apps/kimi-web/test/subagent-lifecycle.test.ts`（新建）
- Modify: `apps/kimi-web/src/api/daemon/agentEventProjector.ts`（`subagent.*` case，~686-722）；并把 `subagent.started` / `subagent.suspended` 从「已知不投影」名单移到 `KNOWN_AGENT_CORE_TYPES`（~891）

- [ ] **Step 1：写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import type { AppEvent } from '../src/api/types';

function tasksFrom(events: AppEvent[]) {
  return events.filter((e) => e.type === 'taskCreated' || e.type === 'taskCompleted');
}

describe('subagent lifecycle projection', () => {
  it('spawned → queued, started → working, completed', () => {
    const p = createAgentProjector();
    const sid = 's1';
    const a = p.project('subagent.spawned', { subagentId: 'sa1', subagentName: 'explore-api', subagentType: 'general', swarmIndex: 0, runInBackground: false }, sid);
    const created = a.find((e) => e.type === 'taskCreated');
    expect(created && created.task).toMatchObject({ id: 'sa1', kind: 'subagent', subagentPhase: 'queued', subagentType: 'general', swarmIndex: 0 });

    const b = p.project('subagent.started', { subagentId: 'sa1' }, sid);
    expect(b.some((e) => e.type === 'taskProgress' || e.type === 'taskCreated' || e.type === 'taskCompleted')).toBe(true);

    const c = p.project('subagent.completed', { subagentId: 'sa1', resultSummary: 'done 12' }, sid);
    const done = c.find((e) => e.type === 'taskCompleted');
    expect(done).toMatchObject({ taskId: 'sa1', status: 'completed' });
  });

  it('suspended carries reason and phase', () => {
    const p = createAgentProjector();
    p.project('subagent.spawned', { subagentId: 'sa2', subagentName: 'refactor', runInBackground: false }, 's1');
    const ev = p.project('subagent.suspended', { subagentId: 'sa2', reason: 'rate limited' }, 's1');
    const upd = ev.find((e) => e.type === 'taskCompleted' || e.type === 'taskCreated' || e.type === 'taskProgress');
    expect(upd).toBeDefined();
  });
});
```

- [ ] **Step 2：跑测试确认失败**

Run: `npx vitest run test/subagent-lifecycle.test.ts`
Expected: FAIL（started/suspended 未投影；spawned 缺 subagentPhase/subagentType/swarmIndex）。

- [ ] **Step 3：扩展投影器**

把 `subagent.spawned` 改为带新字段；新增 `subagent.started` / `subagent.suspended` case。为了能更新已存在的 task，引入一个轻量 `taskUpdated` AppEvent（见 Task 1.3）或复用 `taskCreated`（reducer 对已存在 id 做合并——见 eventReducer `taskCreated` 已有 upsert 逻辑）。本计划用「`taskCreated` upsert」复用既有 reducer 行为：

```ts
case 'subagent.spawned': {
  out.push({ type: 'taskCreated', sessionId, task: {
    id: p?.subagentId ?? ulid('task_'),
    sessionId, kind: 'subagent',
    description: p?.subagentName ?? 'subagent',
    status: 'running',
    subagentPhase: 'queued',
    ...(typeof p?.subagentType === 'string' ? { subagentType: p.subagentType } : {}),
    ...(typeof p?.swarmIndex === 'number' ? { swarmIndex: p.swarmIndex } : {}),
    createdAt: new Date().toISOString(),
  }});
  break;
}
case 'subagent.started': {
  out.push({ type: 'taskCreated', sessionId, task: partialSubagent(s, sessionId, p?.subagentId, { subagentPhase: 'working', startedAt: new Date().toISOString() }) });
  break;
}
case 'subagent.suspended': {
  out.push({ type: 'taskCreated', sessionId, task: partialSubagent(s, sessionId, p?.subagentId, { subagentPhase: 'suspended', suspendedReason: typeof p?.reason === 'string' ? p.reason : undefined }) });
  break;
}
case 'subagent.completed': {
  out.push({ type: 'taskCompleted', sessionId, taskId: p?.subagentId ?? '', status: 'completed', outputPreview: typeof p?.resultSummary === 'string' ? p.resultSummary : undefined });
  break;
}
case 'subagent.failed': {
  out.push({ type: 'taskCompleted', sessionId, taskId: p?.subagentId ?? '', status: 'failed', outputPreview: typeof p?.error === 'string' ? p.error : undefined });
  break;
}
```

> `partialSubagent` 是本文件内的小helper：从投影器维护的 `subagentMeta: Map<id, AppTask>` 取已知字段再覆盖（spawned 时存入）。reducer 的 `taskCreated` 对已存在 id 走「整体替换该 task」，所以 partial 必须带齐已知字段——因此用 Map 缓存 spawned 时的 name/type/swarmIndex。

并把 `'subagent.started'`、`'subagent.suspended'` 加进 `KNOWN_AGENT_CORE_TYPES`。

- [ ] **Step 4：跑测试确认通过**

Run: `npx vitest run test/subagent-lifecycle.test.ts`
Expected: PASS。

- [ ] **Step 5：提交**

```bash
git add apps/kimi-web/src/api/daemon/agentEventProjector.ts apps/kimi-web/test/subagent-lifecycle.test.ts
git commit -m "feat(web): project full subagent lifecycle (started/suspended + meta)"
```

### Task 1.3（可选优化）：用专门的 taskUpdated 事件替代 taskCreated upsert

> 若 Step 3 的「taskCreated upsert + Map 缓存」显得 hacky，可加 `{ type: 'taskUpdated'; sessionId; taskId; patch: Partial<AppTask> }` AppEvent + reducer case（按 id 合并 patch）。这样 started/suspended 只发 patch，不必缓存全量。**YAGNI 判断：** 先用 upsert，若 Map 缓存导致 bug 再升级。

### Task 1.4：内联 AgentGroup 卡片（定板：subagent 内联进 chat）

> **定板对齐：** subagent 的展示位是「内联进 chat、参考 TUI AgentGroup」（见 `web-p3-refined-mockup.html` 第 4 节），**不是** tasks 面板分组。单个子代理 = 一张可展开 Agent 卡；同一步 2+ = AgentGroup 合并卡。
> **⚠ 待确认：** 该展示位用户标了「待最终确认」。若改回 tasks 面板分组，则把本 Task 换成「TasksPane 按 kind 分组」（结构同理，渲染位置从转录改到 tasks tab）。投影层（1.1-1.3）与展示位无关，不变。

**Files:**
- Create: `apps/kimi-web/src/components/AgentCard.vue`（单个子代理：phase + 可展开子工具）、`apps/kimi-web/src/components/AgentGroup.vue`（2+ 子代理合并卡）
- Modify: `apps/kimi-web/src/composables/messagesToTurns.ts`（把同一 turn / 同一步的子代理 toolUse 聚成一个内联块；参考既有 `blocks` 机制——子代理本质是一种 toolUse，按 `parentToolCallId`/同步聚合）
- Modify: `apps/kimi-web/src/components/ChatPane.vue`（`blk.kind === 'agentGroup'` 渲染 `<AgentGroup>`，单个时 `<AgentCard>`）
- Test: `apps/kimi-web/test/agent-group-turns.test.ts`（纯函数：喂含 2 个子代理 toolUse 的消息，断言 `messagesToTurns` 产出一个 `agentGroup` 块含 2 成员；1 个时产出单 `agent` 块）

- [ ] **Step 1：写失败测试**（驱动 `messagesToTurns`，断言子代理被聚成 `agentGroup`/`agent` 块，携带 name/subagentType/phase）。
- [ ] **Step 2：跑测确认失败** → `npx vitest run test/agent-group-turns.test.ts`
- [ ] **Step 3：实现**：`messagesToTurns` 识别子代理 toolUse（toolName 为 agent 类 / 有 subagent 元数据）→ 连续多个聚成 `{kind:'agentGroup', members:[...]}`，单个为 `{kind:'agent', member}`；member 的 phase 取自对应 AppTask（通过 toolCallId 关联）。AgentCard/AgentGroup 样式搬 mockup 的 `.agentcard/.agentgroup`。
- [ ] **Step 4：跑测通过 + `vue-tsc` + oxlint + 浏览器实测**（stub 注入同一步 2 个 subagent，看合并卡）。
- [ ] **Step 5：提交** `feat(web): inline agent / agent-group cards in the transcript`

**Phase 1 验收：** `npx vitest run`（subagent-lifecycle + agent-group-turns 全绿）、`vue-tsc` 0 error、stub 注入 subagent.* 后浏览器看内联卡（单个/合并）随 phase 更新。

---

## Phase 2 · /swarm 内联 TUI 风格卡片

**依赖：** Phase 1 的子代理状态（含 `swarmIndex`/`subagentPhase`）。

**目标：** 把同一波（同 step / 连续 `swarmIndex`）子代理聚成一张内联在转录里的 `SwarmCard`，多列网格 + phase + 进度 + 计数，参考 TUI `apps/kimi-code/src/tui/components/messages/agent-swarm-progress.ts` 与 `reports/web-p3-refined-mockup.html` 的 `.swarm`。

### Task 2.1：从消息流推导 swarm 分组（TDD）

**Files:**
- Create: `apps/kimi-web/src/composables/swarmGroups.ts`（纯函数：`buildSwarmGroups(tasks: AppTask[]): SwarmGroup[]`）
- Test: `apps/kimi-web/test/swarm-groups.test.ts`

- [ ] **Step 1：写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildSwarmGroups } from '../src/composables/swarmGroups';
import type { AppTask } from '../src/api/types';

const t = (over: Partial<AppTask>): AppTask => ({ id: over.id!, sessionId: 's1', kind: 'subagent', description: over.description ?? over.id!, status: 'running', createdAt: 'now', ...over });

describe('buildSwarmGroups', () => {
  it('groups subagents that carry a swarmIndex into one swarm, ordered by index', () => {
    const groups = buildSwarmGroups([
      t({ id: 'a', swarmIndex: 1, subagentPhase: 'working' }),
      t({ id: 'b', swarmIndex: 0, subagentPhase: 'completed', status: 'completed' }),
      t({ id: 'c', kind: 'bash' }), // 非子代理，忽略
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.id)).toEqual(['b', 'a']);
    expect(groups[0]!.counts).toMatchObject({ completed: 1, working: 1 });
  });

  it('subagents without swarmIndex are NOT grouped into a swarm', () => {
    expect(buildSwarmGroups([t({ id: 'x', subagentPhase: 'working' })])).toEqual([]);
  });
});
```

- [ ] **Step 2：跑测确认失败** → `npx vitest run test/swarm-groups.test.ts`
- [ ] **Step 3：实现 `buildSwarmGroups`**（filter `kind==='subagent' && swarmIndex!=null` → sort by swarmIndex → 计 counts by subagentPhase；导出 `SwarmGroup`/`SwarmMember` 类型）。
- [ ] **Step 4：跑测确认通过**
- [ ] **Step 5：提交** `feat(web): derive swarm groups from subagent tasks`

### Task 2.2：SwarmCard 组件 + 接入转录

**Files:**
- Create: `apps/kimi-web/src/components/SwarmCard.vue`（props: `group: SwarmGroup`）
- Modify: `apps/kimi-web/src/components/ChatPane.vue`（在转录里、合适的 turn 处插入 `<SwarmCard>`；最简：当前 session 有活跃 swarm 时，把卡片渲染在最后一个 assistant turn 之后，类似 ApprovalCard 之前的位置）
- Modify: `useKimiWebClient.ts`（暴露 `swarms` computed = `buildSwarmGroups(activeSessionTasks)`）

- [ ] **Step 1：实现 SwarmCard**（结构/样式直接搬 mockup 的 `.swarm/.mcell/.mtop/.mbot`：渐变标题 + 多列 `grid-template-columns:repeat(auto-fill,minmax(216px,1fr))` + 成员 phase 文案用 TUI 同一套；进度条本期用「按 phase 给定档位的 braille 条」近似，SVG 对勾用 `<svg class="ico ok">`）。
- [ ] **Step 2：ChatPane 渲染**：`v-for="g in swarms"` 在转录尾部。
- [ ] **Step 3：`vue-tsc` + oxlint 通过**
- [ ] **Step 4：浏览器实测**：stub-daemon 注入一波 `subagent.spawned/started/completed`（带 `swarmIndex`），看内联卡渲染、phase 随事件更新、多列布局。
- [ ] **Step 5：提交** `feat(web): inline swarm progress card in the transcript`

**风险：** 「同一波」边界判定——本期用 `swarmIndex != null` 即归一张卡；若一个会话先后跑两波 swarm，需要再按「turn / spawn 批次」二次分组（加 `parentToolCallId` 或 turn id 维度）。先做单波，注释标注 TODO。

**Phase 2 验收：** swarm-groups 单测绿；浏览器里内联 swarm 卡随事件更新。

---

## Phase 3 · /goal 常驻条（可展开）+ reducer 状态

**目标：** `goal.updated` → reducer `goalBySession` → dock 上方常驻条（折叠一行 / 点击展开完整卡），complete/null 自动消失。参考 mockup 的 `.goalstrip/.goalexp`。

### Task 3.1：AppGoal 类型 + goalUpdated 事件 + reducer（TDD）

**Files:**
- Modify: `apps/kimi-web/src/api/types.ts`（加 `AppGoal` + AppEvent `goalUpdated`）
- Modify: `apps/kimi-web/src/api/daemon/eventReducer.ts`（state 加 `goalBySession`，case `goalUpdated`）
- Modify: `apps/kimi-web/src/api/daemon/agentEventProjector.ts`（`goal.updated` 从「已知不投影」移出，投成 `goalUpdated`）
- Test: `apps/kimi-web/test/goal-reducer.test.ts`

- [ ] **Step 1：类型**

```ts
export interface AppGoal {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budget: { tokenBudget: number | null; remainingTokens: number | null; turnBudget: number | null; turnsRemaining?: number | null; overBudget: boolean };
}
// AppEvent 增加：
| { type: 'goalUpdated'; sessionId: string; goal: AppGoal | null }
```

- [ ] **Step 2：写失败测试**（reducer：goalUpdated(active) 写入；goalUpdated(complete 或 null) 清除）。
- [ ] **Step 3：reducer state 加 `goalBySession: Record<string, AppGoal | null>` + case：status 为 active/paused/blocked 存入，complete 或 goal===null 删除键。projector：`goal.updated` → 映射 `snapshot` 到 AppGoal（snapshot===null 或 status==='complete' → `{goal:null}`）。
- [ ] **Step 4：跑测确认通过**
- [ ] **Step 5：提交** `feat(web): project goal.updated into reducer goalBySession`

### Task 3.2：GoalStrip 组件 + dock 接入

**Files:**
- Create: `apps/kimi-web/src/components/GoalStrip.vue`（props: `goal: AppGoal`；本地 `expanded` ref；折叠/展开两态，样式搬 mockup 的 `.goalstrip/.goalexp/.gbar`）
- Modify: `apps/kimi-web/src/components/ConversationPane.vue`（dock 里、QuestionCard/ApprovalCard/Composer 之上渲染 `<GoalStrip v-if="goal">`）
- Modify: `useKimiWebClient.ts`（暴露 `goal` computed = `goalBySession[activeSessionId]`）

- [ ] **Step 1：实现 GoalStrip**（折叠：`▸ 目标 <objective截断> <进度条> 62% ⌄`；展开：状态徽标 + objective 全文 + completionCriterion + `turnsUsed/tokensUsed` + 预算条；点击切换 expanded）。
- [ ] **Step 2：ConversationPane dock 接入**（注意 dock 高度变化已有 ResizeObserver，会触发 follow-to-bottom，无需额外处理）。
- [ ] **Step 3：挂载测试**（`test/goal-strip.test.ts`：active goal 渲染折叠条、点击展开显示 objective 全文、status complete 时父层不渲染）。
- [ ] **Step 4：`vue-tsc` + oxlint + 浏览器实测**（stub 注入 goal.updated）。
- [ ] **Step 5：提交** `feat(web): goal dock strip with expand`

**Phase 3 验收：** goal-reducer 单测绿；浏览器里 goal 条随事件出现/展开/消失。

---

## Phase 4 · plan / goal / swarm 激活徽标（状态行）

**目标：** 在 ConversationPane 状态行加三个独立徽标：`[plan]`（plan 模式）/ `[goal ● active · 4m · 7 turns]`（活跃目标）/ `[swarm ⟳ x/n]`（有 swarm 在跑）；可点击跳转。参考 mockup 的 `.abadge` + TUI footer。

**说明：** 三者都从既有状态派生，**无新事件**：plan 来自 `rawState.planMode`；goal 来自 Phase 3 的 `goalBySession`；swarm 来自 Phase 2 的 `buildSwarmGroups`（有任一组在跑）。

### Task 4.1：activation computed（TDD）

**Files:**
- Modify: `useKimiWebClient.ts`（加 `activationBadges` computed）
- Test: `apps/kimi-web/test/activation-badges.test.ts`（用既有 session-cache mock 模式，注入 planMode / goal / swarm 状态，断言 computed 输出）

- [ ] **Step 1-2：写失败测试 + 跑失败**（断言：planMode → 含 plan 徽标；active goal → 含 goal 徽标带 turns；有运行中 swarm → 含 swarm 徽标带 x/n）。
- [ ] **Step 3：实现 `activationBadges` computed**，返回 `{ plan: boolean; goal: {status,turnsUsed,elapsedMs}|null; swarm: {done,total}|null }`。
- [ ] **Step 4-5：跑测通过 + 提交** `feat(web): derive plan/goal/swarm activation badges`

### Task 4.2：状态行渲染徽标

**Files:**
- Modify: `apps/kimi-web/src/components/ConversationPane.vue` 或 `Composer.vue` 的状态行（看 P0-2 时 `status` computed 所在；状态行在 Composer 底部 `.statusline`）

- [ ] **Step 1：渲染三徽标**（样式搬 mockup `.abadge.plan/.goal/.swarm`；点击 goal → 展开 GoalStrip / 滚到它；点击 swarm → 滚到对应 SwarmCard）。
- [ ] **Step 2：`vue-tsc` + oxlint + 浏览器实测**（plan 切换、goal 活跃、swarm 跑动时徽标出现/消失）。
- [ ] **Step 3：提交** `feat(web): show plan/goal/swarm activation badges in the status line`

**Phase 4 验收：** activation 单测绿；浏览器里三徽标按状态独立出现，可点击。

---

## Phase 5 · Terminal 作为普通 tab（xterm + WS 数据通道）

**目标：** 在 chat/tasks/todo 同级加 `terminal` tab，跑通单个终端：REST 创建 + WS attach/input/resize/close + output/exit。后端已就绪（`packages/server/src/routes/terminals.ts` + `ws-control.ts` 的 `terminal_*` 帧）。

### Task 5.1：依赖 + API client

**Files:**
- Modify: `apps/kimi-web/package.json`（加 `@xterm/xterm`、`@xterm/addon-fit`）
- Modify: `apps/kimi-web/src/api/types.ts`（`AppTerminal` + KimiWebApi 方法签名）、`apps/kimi-web/src/api/daemon/client.ts`（`createTerminal/listTerminals/getTerminal/closeTerminal`）
- Test: `apps/kimi-web/test/terminal-client.test.ts`（stub fetch，断言 REST 形状，参考 `debug-trace.test.ts` 的 fetch stub）

- [ ] **Step 1：装依赖** `pnpm -C apps/kimi-web add @xterm/xterm @xterm/addon-fit`
- [ ] **Step 2-5：TDD client 方法**（REST：`POST/GET /sessions/{id}/terminals`、`GET .../{tid}`、`POST .../{tid}:close`），跑测、提交。

### Task 5.2：WS 终端帧通道（TDD）

**Files:**
- Modify: `apps/kimi-web/src/api/daemon/ws.ts`（`DaemonEventSocket`：发 `terminalAttach/Input/Resize/Detach/Close`；`handleFrame` 识别 `terminal_output`/`terminal_exit` → 新 handler `onTerminalOutput(tid,data,seq)` / `onTerminalExit(tid,exitCode)`；`onServerHello` 后用记录的 `lastSeq` 重 attach）
- Modify: `apps/kimi-web/src/api/daemon/client.ts`（`connectEvents` 暴露终端方法 + handler 透传）
- Test: `apps/kimi-web/test/terminal-ws.test.ts`（stub WebSocket，参考 `debug-trace.test.ts` 的 ws stub，断言：attach 帧编码正确、output 按 terminal_id 分发、重连用 since_seq）

- [ ] **Step 1-5：** 写失败测试 → 实现帧收发 + 重连重放 → 跑测通过 → 提交 `feat(web): terminal WS data channel with since_seq replay`

### Task 5.3：Terminal.vue + terminal tab

**Files:**
- Create: `apps/kimi-web/src/composables/useTerminal.ts`（create→attach→流式；`onData`→input；fit→resize 防抖 100ms；exit→只读 + 重开）
- Create: `apps/kimi-web/src/components/Terminal.vue`（xterm 容器 + FitAddon + ResizeObserver + 三套主题映射成 xterm `ITheme`，跟随 `useIsDark`/data-theme）
- Modify: `apps/kimi-web/src/components/TabBar.vue`（加 `terminal` tab；`PaneKey` 扩枚举）、`ConversationPane.vue`（`active==='terminal'` 渲染 `<Terminal>`）

- [ ] **Step 1：实现 useTerminal + Terminal.vue**（注意项目记忆：后台标签页 rAF 冻结——`since_seq` 重放保证切回前台补齐输出）。
- [ ] **Step 2：TabBar/ConversationPane 接入 terminal tab。**
- [ ] **Step 3：stub-daemon 加假 pty**（`/sessions/{id}/terminals` 返回假 terminal，WS 回显 `terminal_input` 为 `terminal_output`）→ 浏览器实测输入/输出/resize/exit/重开。
- [ ] **Step 4：`vue-tsc` + oxlint + `vitest run`（无回归）**
- [ ] **Step 5：提交** `feat(web): single terminal tab (xterm + pty)`

**风险：** xterm 主题与三套 kimi 主题对齐；`fit` 在 tab 隐藏时容器 0 尺寸→切到 terminal tab 时再 `fit()`。

**Phase 5 验收：** terminal-client/terminal-ws 单测绿；浏览器里 terminal tab 可交互。

---

## Phase 6 · 视图分屏（tab/视图维度，VSCode 编辑器组）

**目标（完全体）：** 会话区可任意横/竖劈成多个「视图组」，每组独立持有 chat/tasks/todo/files/terminal **之一**；可拖拽视图在组间移动、调分隔比例、布局持久化；窄屏退化单组整屏切。**不是**在 terminal 标签内部分屏。

> 这是 P3 里最大的一块、且重构 ConversationPane 的视图层。建议**单独 spec + 单独计划**再展开到步骤级；本计划给到架构与拆分骨架。

### 架构骨架

- **视图模型**：把当前「ConversationPane 一个 active tab」升级为「布局树」：`type Layout = { dir: 'row'|'col'; children: (Layout | Group)[]; sizes: number[] } | Group`，`Group = { id; views: PaneKey[]; active: PaneKey }`。单组即退化为今天的行为。
- **组件**：`SplitLayout.vue`（递归渲染布局树 + 拖拽分隔，复用 `useResizable`/`ResizeHandle`）→ 每个叶子 `ViewGroup.vue`（一条视图 tab 条 + 当前 view 内容；view 内容复用现有 ChatPane/TasksPane/TodoCard/FileTree/Terminal）。
- **持久化**：布局树存 localStorage（`kimi-web.layout`，按会话或全局）。
- **拖拽分屏**：把视图 tab 拖到另一组的边缘 → split 该组；拖出 → 新建组。首版可先只做「分隔条拖拽调比例 + 右键/按钮『向右/向下拆分』」，tab 拖拽作为增强。
- **窄屏**：`useIsMobile` 时强制单组、忽略布局树。

### 分阶段（每步可单独 PR）

- [ ] **6.1：布局数据模型 + 持久化（TDD）** — `apps/kimi-web/src/composables/usePaneLayout.ts` 纯逻辑：split/close/move/resize 布局树操作 + 序列化；单测覆盖。
- [ ] **6.2：ViewGroup.vue** — 一条视图 tab 条（chat/tasks/todo/files/terminal）+ 内容插槽，把现有各视图塞进去。先在「单组」模式下跑通（等价今天的 ConversationPane tab）。
- [ ] **6.3：SplitLayout.vue** — 递归渲染 + 分隔条拖拽（`useResizable`）+ 「向右/向下拆分」按钮。
- [ ] **6.4：ConversationPane 切换到 SplitLayout** — 用布局树替换单 active tab；窄屏退化。
- [ ] **6.5：tab 拖拽移动/分屏（增强）** — HTML5 DnD 把视图在组间拖移。
- [ ] **每步：** `vue-tsc` + oxlint + 浏览器实测（拖拽、持久化、窄屏退化）。

**Phase 6 验收：** usePaneLayout 单测绿；浏览器里可把 chat 与 terminal 并排、拖拽调比例、刷新后布局还在、窄屏退化单组。

---

## 跨阶段风险 & 注意

- **投影器丢帧/重连**（和 P0-1 同源）：subagent/goal 事件若在重连窗口丢失，状态可能短暂不一致；快照恢复（snapshot）需带上 in-flight 的 goal/subagent 状态——若 daemon 快照未含，记为已知限制并在 `goal.updated`/`subagent.*` 再次到达时自愈。
- **Vue 组件测试边界**：本仓库单测主力是 composable/projector/reducer/纯函数；组件用 `@vue/test-utils` 挂载测「模板分支逻辑」（参考 stash 的 `files-tab-no-git.test.ts`），视觉/交互仍以 stub-daemon 浏览器实测为准（项目记忆：后台标签页 rAF 冻结坑、iframe 测移动端）。
- **stub-daemon 覆盖**：Phase 1-4 需要 stub 能发 `subagent.*`/`goal.updated`；Phase 5 需要假 pty + `terminal_*` 帧。这些 stub 路由要随代码一起加（项目记忆：跑旧 stub 会话会加载失败）。
- **主题三套**：新组件颜色一律走 token（`--blue/--ok/--soft/--mono`…），别硬编码；xterm 单独映射 `ITheme`。

## 建议执行顺序（再次明确）

Phase 1（子代理投影，可单测、解锁 2/4）→ Phase 2（swarm 卡）→ Phase 3（goal 条）→ Phase 4（激活徽标，依赖 2/3）→ Phase 5（terminal tab）→ Phase 6（视图分屏，最大、建议单独 spec）。

P3-17 = Phase 1-4；P3-16 = Phase 5-6。
