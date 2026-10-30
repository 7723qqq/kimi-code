# Requirements — 审查结论落地：四项缺陷修复与四项疑点测量

本 spec 把 2026-10-29 提交审查的结论落成可验证的代码改动。四项缺陷必须修完，每项都要有“旧实现跑红、新实现跑绿”的测试；四项疑点必须先测量，再决定修或证伪，**证伪的不改代码**。

## 目标

1. 修掉四条已确认缺陷，且每条的不变量都有结构化断言守着。
2. 用仓库既有 bench 设施给出旧/新实现的对比数字，作为“确有提升”的证据。
3. 对四条疑点各给一个可复现的测量结论：要么复现并修掉，要么用数据证伪并写明测量方式。

## 受众

维护 `packages/agent-core-v2`、`packages/pi-tui`、`apps/kimi-code/src/tui` 的开发者，以及复核这次修复的 reviewer。读这份文档是为了知道：改哪个符号、验收看哪条断言、复现用哪条命令。

## 背景事实（上一轮审查结论，行号已核对）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `handlerFor` 每次 `acquire` 后直接 `leases.set` 覆盖旧租约，旧租约永不 `dispose`，`references` 只增不减，workspace 实例不释放 | `packages/agent-core-v2/src/app/workspaceLifecycle/workspaceLifecycleService.ts:59-64`；`workspaceInstanceManagerService.ts:210-219` |
| F2 | 每个 step 追加一个首 token 样本并整数组复制，平均值每次渲染全量 `reduce`；单会话内无界 | `apps/kimi-code/src/tui/utils/session-stats.ts:78`、`:88-92` |
| F3 | `resumeFailures` 只在同一 session 下一次 `resume` 时删除，失败后放弃的 session 永久留一条 `Error` | `packages/agent-core-v2/src/app/sessionManager/sessionManagerService.ts:111`（写）、`:97`（唯一删除点） |
| F4 | `programStatuses` 只写不删；`{state:'clear', id}` 也留下一条记录，`stop()` 不清表 | `packages/pi-tui/src/terminal.ts:187`、`:373-375`、`:542-552` |
| S1 | 审批面板展开态被 `measure` 与 `paint` 各渲染一次 | `approval-region.ts:171-176`、`status-surface/index.ts:689-692` |
| S2 | subagent 失败路径 `readOutput(taskId)` 把落盘日志整段读入（上限 16MB） | `agentTool.ts:611` → `taskService.ts:641-646` → `persist.ts:142-189` |
| S3 | `McpConnectionManager.shutdown()` 未清 `listeners`/`operationTails`/`needsAuthTransitions` | `connection-manager.ts:472-488` |
| S4 | 终端进度 `setInterval` 未 `unref` | `terminal.ts:656-670` |

## 范围

### 纳入

**R0 测试执行资源约束（最高优先级；违反即交付失败）**

上一轮在未限制并发的情况下同时启动了两个包的全量套件，把机器打到 98% CPU。以下为硬约束：

- R0.1 同一时刻最多存在一个测试进程组。禁止并行启动两个 `bun run test`、两个包级套件，或一个套件加一个 bench。
- R0.2 套件禁止后台运行。必须前台执行，运行期间不发起 `typecheck`、`lint`、bench 或构建。
- R0.3 包级与根级套件显式 `--parallel=8`（上限 8 路），并受仓库自带的 20 核上限约束（`scripts/lib/cpu-limit.mjs`）；不得依赖未显式声明的默认值。
- R0.4 单文件验证一律 `bun test <file>`，不经过 `run-package-tests.mjs`。
- R0.5 根级 `bun run test` 只在最后跑一次。
- R0.6 每次启动套件之前先做进程预检：列出所有 `bun.exe` 的命令行，若存在另一个 `run-package-tests` / `bun test` / `run-tests.mjs`，等待其结束再启动。
- R0.7 交付说明必须附上每条套件命令的 `--parallel` 参数与预检输出结论。

**R1 workspace 租约泄漏**

- 不变量：任一时刻每个 workspace 的存活租约数等于存活 handle 数。
- 重复或并发调用 `handlerFor` 不得让引用计数净增长。
- 替换顺序固定为“先拿新租约 → 写入 map → 释放被替换的旧租约”，中间态不得让计数归零触发 `close()`。
- 既有语义保持：同一 workspace 返回同一 handle（`workspaceLifecycle.test.ts:219` 的并发用例不变），`handlers.list()` 的顺序与数量不变。
- 公开签名 `IWorkspaceLifecycleService.handlerFor` 不变。

**R2 首 token 采样**

- 不变量：读数仍是所有样本的精确算术平均，不允许丢样本、滑窗或改变显示值。
- 单次累加与单次取值都不得随 step 数增长。
- 屏幕输出逐字节不变：同样的 i18n key、同样的 `formatStatDuration` 小数位。
- 公开签名 `firstTokenAverageMs(stats)` 不变；`SessionStats` 的字段可以改，但 `createEmptySessionStats`、`kimi-tui.ts:4711` 的调用点与所有构造 `SessionStats` 的测试夹具要一起改到位。

**R3 `resumeFailures` 上界**

- 失败记录必须有上界或随会话生命周期消失。
- `whenResumeSettled` 语义不变：对仍在记录中的 session，失败后要能抛出原错误。
- `dispose()` 后该表为空。

**R4 OSC 7501 记录**

- 写入 `{ state: 'clear', id }` 时删除该 id 的记录，而不是留下 clear 记录。
- `stop()` 清空整张表。
- `id === undefined` 的根记录照旧保留。
- `confirmProgramStatusSupport` 的重放行为不变：只重放仍在表中的记录。
- 公开签名 `Terminal.setProgramStatus` 不变。

**R5 疑点处理**

- S1–S4 每条都必须有：测量方式、原始数据、结论（修 / 证伪）。
- 判定为“证伪”的不许改代码。
- 判定为“要修”的，必须有对应的结构不变量测试或可复现的前后数字。

### 排除

- 不推送 `origin`；提交留在本地，推送需要单独确认。
- 不改 UI 文案与 i18n key，不新增依赖，不用 `--no-verify`。
- 不顺手重构无关代码；工作树里既有的未提交改动原样保留，不回退、不混入无关修改。
- 不在本 spec 内处理上一轮审查之外的问题。

## 交付物

1. 改动清单：文件:行 + 对应缺陷编号。
2. 四条疑点各自的结论与测量方式。
3. 新增/修改的测试与 bench 文件路径。
4. 旧/新实现 bench 对比表（session-stats 1k/10k/50k；handlerFor N=100/1000）。
5. 最后一轮测试、typecheck、lint、locale 检查的输出结论。

## 验收标准

- A1 `bun test packages/agent-core-v2/test/app/workspaceLifecycle/workspaceLifecycle.test.ts` 在旧实现上至少两条失败、在新实现上 17 条全过；替身能报出 acquire/dispose 次数与最小存活数。
- A2 `bun test apps/kimi-code/test/tui/utils/session-stats.test.ts` 断言 10k 步的平均值等于逐样本求平均参考值，且 10k 步与 1k 步的单次累加/取值耗时不出现数量级差异；旧实现该用例失败。
- A3 `bun test packages/agent-core-v2/test/app/sessionManager/sessionManagerService.test.ts` 断言 70 个不同 session 连续失败后表尺寸 ≤ 64，最新失败仍能抛出原错误，`dispose()` 后为 0；旧实现尺寸断言失败。
- A4 `bun test packages/pi-tui/test/terminal.test.ts` 断言 100 个子记录 clear 后表尺寸回到 1（仅根记录）、`stop()` 后为 0、重放不再包含已清理的 id；旧实现尺寸断言失败。
- A5 两条 bench 输出可直接对比的 ms/op 与计数表，且 bench 不作为 CI 断言。
- A6 四条疑点各有一条结论，且“证伪”项在 diff 中没有对应代码改动。
- A7 R0 的每条命令都有记录，且不存在并发套件。
- A8 `bun run check:no-comments` 通过（`agent-core-v2` 为注释禁写区）。
