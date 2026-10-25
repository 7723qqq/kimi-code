# Design — hello-world staged dev-run mode

## 取舍裁决（不确定项，按仓库规则与代码事实决断）

| 争议点 | 裁决 | 依据 |
| --- | --- | --- |
| run 产物目录 | `specs/<id>/` 四件套（requirements.md / design.md / tasks.md / progress.md） | AGENTS.md：specs/ 是仓库既有需求契约目录，形态与 run 产物一一对应；不新增顶层目录 |
| 硬门禁范围 | 不做编码工具 veto；门禁 = 证据推进 + checklist + `off` 时未完项警告（软） | CONVENTIONS「Simplest way」；过度门禁是风险；plan/spec 已有强限制不叠加 |
| 阶段粒度 | 7 阶段；version/CI 为横切；maintain 为收尾闭环 | 阶段过细会放大推进误判面 |
| 轮末自动退出 | 移除（task 触发也跨轮存活） | 开发 run 是多轮工作，退出由 `/hello-world off` 决定 |
| Agent 工具 veto | 移除 | 开发流程需要 Agent/AgentSwarm 等全部工具 |
| 已有 changeset | 直接改写未发布的 `.changeset/hello-world-mode.md` | 两个提交均未发布，changelog 按 release 聚合 |
| 产物冲突（hello-world 与 spec 模式共用 specs/） | 各 `<id>` 独立目录，互不覆盖；hello-world 的证据匹配按 `specs/*/文件名` 通配 | 不改 spec 模式约定 |

## 接口契约（实施照此签名，勿改名）

现状修正（A2 发现）：`sdk-rpc-client-v2.setHelloWorldMode` 不消费 `input.trigger`（走
`mutex.switchTo` 会固定 `enter('manual')`）。**改为直调 `helloWorld.enter(trigger, task)`**
——enter 事件本身会经 modeMutex 的 `evictConflictsOf('hello-world')` 完成互斥驱逐（CONFLICTS 已含
spec/swarm/tower），与 switchTo 语义等价且保住 trigger/task；`exit` 路径不变。modeMutex 其余代码不动。

```ts
// packages/agent-core-v2/src/features/helloWorld/agent/helloWorld.ts 追加
export const HELLO_WORLD_STAGES = [
  'requirements', 'design', 'implement', 'test', 'review', 'docs', 'deliver',
] as const;
export type HelloWorldStage = (typeof HELLO_WORLD_STAGES)[number];
export type HelloWorldRunItemId =
  | 'requirements-approved' | 'design-written' | 'tasks-complete'
  | 'tests-green' | 'review-done' | 'docs-updated' | 'changeset-ready';
export interface HelloWorldRunItem {
  readonly id: HelloWorldRunItemId;
  readonly done: boolean;
  readonly evidence?: string;
}
export interface HelloWorldRunState {
  readonly stage: HelloWorldStage;
  readonly task?: string;
  readonly items: readonly HelloWorldRunItem[];
  readonly waivers: readonly HelloWorldRunItemId[];
}
export interface IAgentHelloWorldService {
  readonly _serviceBrand: undefined;
  readonly isActive: boolean;
  readonly run: HelloWorldRunState | null;
  enter(trigger: HelloWorldModeTrigger, task?: string): void;
  exit(): void;
  advance(stage: HelloWorldStage | 'next'): void;
  waive(item: HelloWorldRunItemId): void;
}
```

- `helloWorldOps.ts`：`HelloWorldModeEnter` payload 增 `task?: string`；新增持久事件
  `HelloWorldRunUpdated`（type `hello_world_run.updated`，payload
  `{ agentId, stage, task?, items, waivers }`）；新增 `helloWorldRunKey = defineState('helloWorldRun',
  (): HelloWorldRunState | null => null).replayable(...)`，折叠：Enter 建 run（stage=requirements）、
  RunUpdated 换快照、Exit 清 null。RunUpdated 发 `AgentStatusUpdated({ agentId, helloWorldStage: stage })`。
- `usageEvents.ts`：`AgentStatusUpdatedPayload.helloWorldStage?: HelloWorldStage`
  （type import 自 `#/features/helloWorld/agent/helloWorld`）；`AgentStatusUpdatedEvent` 同步。
- telemetry：`hello_world_stage_changed`（`{ stage: string; previous: string }`）。
- node-sdk：`Session.setHelloWorldStage(stage: HelloWorldStage | 'next')`、
  `Session.waiveHelloWorldItem(item: HelloWorldRunItemId)`；
  `SetSessionHelloWorldStageRpcInput { sessionId, stage }`、
  `WaiveHelloWorldRunItemRpcInput { sessionId, item }`；
  `SessionStatus.helloWorldStage?: string; helloWorldRun?: { stage; task?; items; waivers }`；
  `ResumedAgentState.helloWorldStage?: string`；sdk-rpc-client-v2 走 `IAgentHelloWorldService.advance/waive`。
- sessionLegacy：status 增 `hello_world_stage: z.string().optional()`。
- transcript：`modes['hello-world']` 值扩为 `{ trigger?: string; stage?: string }`
  （contract/schema、model/meta、ops/apply）；foldFacts 折 `hello_world_run.updated`，
  stage 变化时 push marker `hello-world.stage`；kap-server `events-zod` / `ws v1 events` /
  `coreEventMap` 透传 `helloWorldStage` 进 modes merge。

## 阶段行为与证据推进表（helloWorldService 经 hook 观察实现）

观察面（已核对）：`toolExecutor.onBeforeExecuteTool: Event<BeforeToolExecuteEvent>`；
`toolExecutor.hooks.onDidExecuteTool.register(id, fn)`，`ToolDidExecuteContext` 含
`toolCall`(name)、`args`、`outcome`、`result: ExecutableToolResult{ output, isError? }`。

| 信号（工具 + 路径/命令特征） | 前置 stage | 推进到 | 顺带打勾 |
| --- | --- | --- | --- |
| Write/Edit `specs/*/requirements.md` | requirements | design | requirements-approved |
| Write/Edit `specs/*/design.md` 或 `specs/*/tasks.md` | design | implement | design-written、tasks-complete |
| Write/Edit 非 specs/、非 docs/、非 .changeset 的代码路径 | requirements/design | implement | — |
| Bash `command` 匹配 `/\bbun\b.*\b(test\|lint\|typecheck\|check:)/` 且 `result.isError !== true` | implement | test | — |
| 同上命令且成功 | test | review | tests-green |
| Write/Edit `docs/**` 或 `README*` | review | docs | review-done |
| Write/Edit `.changeset/*.md` | docs | deliver | docs-updated、changeset-ready |

规则：阶段只进不退；重复信号幂等；`advance('next')` 取下一阶段、越界 no-op；`waive(id)` 记入
`waivers` 并把对应 item 打勾（evidence='waived'）；手动 `advance/phase` 与自动推进同权重。

## 登记与测试同步清单（A1/A2/A3 补充，遗漏即核验扣分）

- `test/index.test.ts` 的 `V2_RECORD_TYPES` 登记 `hello_world_run.updated`。
- `test/state/builtinReplayableKeys.ts` 登记 `helloWorldRunKey`。
- transcript `model/item.ts` `KNOWN_MARKERS` 增 `hello-world.stage`；`coreEventMap` modes 值类型
  从 `Record<string, never> | null` 扩为可携带 `{ stage?: string }`；foldFacts 既有 `{}`
  写入点（foldFacts.ts:864 附近）带 stage。
- 既有 `helloWorld.test.ts` 四条断言（约 :184/:221/:256/:268：轮末自动退出、Agent veto）随行为
  变更更新为新语义断言，不算回归。
- status-line 用户载荷**不**新增字段（保持既有用户契约）；`message-replay` 增 `helloWorldStage`
  以支持恢复徽章。

## 注入设计（C2 模型资产，英文，改动=行为变更）

- `agent/enter-reminder.md` 重写为 run 开场（task、stage、checklist 现状、四件套产物约定）。
- 新增 `agent/stages/{requirements,design,implement,test,review,docs,deliver}.md`：每阶段剧本
  （目标、做什么、退出证据），命令以本仓为准（`bun test --isolate <paths>`、`bun run test`、
  `bun run lint`、`bun run typecheck`、`check:*`、`tools/review`、gen-changesets）。
- `agent/exit-reminder.md` 重写为收尾摘要指引（列 open items、写 `specs/<id>/progress.md`、
  四类维护归档、下轮 run 种子）。
- `helloWorldInjection` 按 stage 渲染（stage 剧本 + run 头），disclosure
  `{ kind: 'hello_world_mode', state, stage }`，stage 变更即重注入；保留退出时 pop 尾注逻辑。

## TUI 设计

- 命令语法：`/hello-world`（翻转）| `on` | `off` | `<task>` | `status` | `next` | `phase <stage>` | `skip <item>`。
  `off` 时 open items > 0 先警告列出（仍执行 off）；`<task>` 保持「开模式 + 发提示词」。
- footer 徽章 `hello-world:<stage>`（对齐 `spec:${stage}` 形态）；stage 变更渲染 marker；
  `/status` 行显示 `on · <stage>`；`/hello-world status` 渲染 run 面板（stage、task、items、evidence、waivers）。
- i18n（en/zh）：命令提示、status 面板、marker、新消息键（C1 走 `t()`；阶段 id 是 C3 不本地化）。

## 文件所有权（越界即违规，核验会查）

| 区域 | 拥有文件 |
| --- | --- |
| B1 引擎+SDK | `packages/agent-core-v2/src/features/helloWorld/**`、`src/agent/usage/usageEvents.ts`、`src/app/telemetry/events.ts`、`src/agent/contextMemory/contextOps.ts`（如需）、`src/index.ts`、`packages/node-sdk/src/{rpc,session,types,replay,sdk-rpc-client-v2}.ts`、`packages/agent-core-v2/test/**`（helloWorld/modeMutex/index/builtinReplayableKeys/sessionLegacy） |
| B2 状态链 | `packages/transcript/src/**`、`packages/kap-server/src/**`、`packages/agent-core-v2/src/app/sessionLegacy/**`、`packages/agent-core-v2/docs/*manifest*`（重生成）、`packages/transcript/test/**`、`packages/kap-server/test/**` |
| B3 TUI+i18n | `apps/kimi-code/src/**`、`apps/kimi-code/test/**` |
| B4 文档+changeset | `docs/**`、`DEVELOP.md`、`README.md`、`README.zh-CN.md`、`.changeset/hello-world-mode.md` |
| C1–C3 核验 | 只读 + 跑命令；报告写 `.tmp/hello-world-dev-workflow/reports/` |

依赖顺序：B1 先行 → B2/B3/B4 并行 → C 并行核验 → 打回重做（≤2 轮）→ 终检 → 提交推送。

## 风险与对策

1. 自动推进误判：证据表保守、只进不退、手动 `next/phase` 兜底；误判不阻塞（不作硬门禁）。
2. 注入体积：每轮只注入当前阶段剧本 + run 头；全局流程图放开场一次性注入。
3. 状态形状变更兼容：`helloWorldKey` 保持 trigger|null 不动，新增 `helloWorldRunKey`，
   旧 journal 回放不受影响。
4. 子代理并行冲突：文件所有权分区 + 依赖排序；核验代理只读。
