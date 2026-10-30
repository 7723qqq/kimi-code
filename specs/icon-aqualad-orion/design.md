# Design — 审查结论落地

## 现状与前提

- 工作树已有 47 个文件的未提交改动（缓存命中读数、kosong cache 字段等），与本次四条缺陷无重叠，但占用了 `apps/kimi-code/src/tui/utils/session-stats.ts`、`types.ts` 及其两个测试文件。**这些改动原样保留**，不回退、不混入无关修改。
- 缺陷 1 的红测试与修复已落在本地（未提交）：`workspaceLifecycle.test.ts` 新增两条用例并给替身加了 acquire/dispose/最小存活计数；`workspaceLifecycleService.ts` 已按“先取新、再替换、后释放”修好。红证据：旧实现下两条用例 `liveLeases` 期望 1、实际 2；修后 17 pass / 0 fail。
- 其余三条缺陷、四条疑点、bench、changeset 均未开始。

## 测试执行协议（R0 的落地机制）

**T1（默认推荐）：协议 + 进程预检，不改仓库脚本。** 每次启动套件前先跑预检，确认没有别的 bun 测试进程，然后前台串行执行：

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='bun.exe'\" | Select-Object ProcessId,CommandLine | Format-Table -AutoSize -Wrap"
# 输出里出现 run-package-tests / run-tests.mjs / bun test 即视为有并发套件，等待或终止后再继续
```

固定的执行顺序与参数（每条单独一次，跑完再看下一条）：

| 阶段 | 命令 | 并发 |
| --- | --- | --- |
| 单文件 | `bun test <file>` | Bun 默认（单文件） |
| 包级 | `cd packages/agent-core-v2 && bun run test --parallel=2` | 2 |
| 包级 | `cd apps/kimi-code && bun run test --parallel=2` | 2 |
| 根级（仅一次） | `bun run test --parallel=2` | 2 |
| 类型 | `bun run typecheck`（内部 `build:packages` 串行） | 构建自身 |
| Lint | `bun run lint` | 自身 |

**T2（可选，需你确认才做）：包级 runner 单实例锁。** 在 `scripts/run-package-tests.mjs` 启动时用 `.tmp/test-suite.lock`（`wx` 打开，写 PID/命令/时间）互斥：已有存活 PID 时打印占用者并 `exit 1`；陈旧锁自动回收；`KIMI_TEST_SUITE_LOCK=off` 供 `test:watch` 的并发 watcher 旁路。根 runner 串行地派生子进程，因此一把锁即可覆盖“根+包”“包+包”“根+根”三种并发。这会改一个 CI 也在用的脚本，所以默认不选。

## D1 workspace 租约

```ts
async handlerFor(ref: WorkspaceRef): Promise<IWorkspaceScopeHandle> {
  const lease = await this.manager.acquire(ref);
  const handle = this.handleOf(lease.instance);
  const replaced = this.leases.get(handle.id);
  this.leases.set(handle.id, lease);
  replaced?.dispose();
  return handle;
}
```

顺序保证：`acquire` 使计数 +1，`set` 之后 `dispose` 使计数 -1，任何中间态都 ≥ 1，不会误触发 `close()`。`handle.dispose()` 仍负责销毁 controller 与当前租约。

测试替身（`workspaceLifecycle.test.ts:65` 的 `managerStub`）新增 `liveLeases / minLiveLeases / disposedLeases` 三个观测点；用例：

1. 串行两次 `handlerFor`：`acquire=2`、`dispose=1`、活租约=1、最小存活=1。
2. `Promise.all` 两次：同上。
3. `handler.dispose()` 后活租约=0。

**已确认红**：旧实现下 1、2 失败（活租约 2），3 通过。

公开签名与 `handlers.list()` 语义不变；并发用例 `:219` 原样保留。

## D2 首 token 采样

`SessionStats` 用两个标量替代数组：

```ts
firstTokenTotalMs: number;    // 所有样本的累加和（按到达顺序）
firstTokenSampleCount: number;
```

- `createEmptySessionStats`：两者为 0。
- `accumulateStepCompleted`：合法样本执行 `total += v; count += 1`，不再复制数组，O(1)。
- `firstTokenAverageMs`：`count === 0 ? null : total / count`，O(1)。

**逐字节等价论证**：旧实现是 `samples.reduce((acc, s) => acc + s, 0) / samples.length`，即按样本到达顺序做左结合浮点加法；新实现按同一顺序把同一批双精度数累加到同一个初值 0 上。IEEE-754 加法确定，操作数序列与结合顺序完全一致，因此 `total / count` 与旧式 `sum / length` 逐位相等，渲染路径（`formatStatDuration`、i18n key）不需任何改动。

改动点：`apps/kimi-code/src/tui/types.ts:149`、`apps/kimi-code/src/tui/utils/session-stats.ts:38,78,88-92`、`test/tui/utils/session-stats.test.ts`、`test/tui/components/chrome/footer-session-stats.test.ts`。`kimi-tui.ts:4711` 只调用 `accumulateStepCompleted`，无需改动。

新增测试：

- 10k 步后 `firstTokenAverageMs` 等于“把同一批数存进数组再 `reduce/len`”的参考值（严格 `toBe`）。
- 结构不增长：`JSON.stringify(stats)` 的长度在 1k 与 10k 步时相同。
- 量级守卫：对 1k 步状态与 10k 步状态各做 20 万次“累加 + 取平均”，断言总耗时比 `< 3`（旧实现在此项约 10×）。取 20 万次聚合以压掉计时噪声，只守“没有量级变化”，不做绝对耗时断言。

## D3 `resumeFailures` 上界

```ts
const MAX_RESUME_FAILURES = 64;
// set 之后：
while (this.resumeFailures.size > MAX_RESUME_FAILURES) {
  const oldest = this.resumeFailures.keys().next().value;
  if (oldest === undefined) break;
  this.resumeFailures.delete(oldest);
}
```

- 插入顺序即淘汰顺序（`Map` 保证）；失败记录只在“同一 session 的下一次 resume”或淘汰时消失。
- `dispose()` 末尾 `this.resumeFailures.clear()`。
- 语义：刚失败、马上 `whenResumeSettled` 的调用仍在表内，仍抛原错误；只有 64 个更晚的不同 session 失败后，最老的记录才会被淘汰。这个取舍写进 changeset。

测试：70 个不同 session 连续失败（reuse `sessionManagerService.test.ts:431` 的 fake 结构），断言表尺寸 ≤ 64、最新 session 的 `whenResumeSettled` 仍抛 `boom`、`dispose()` 后为 0。旧实现 70 条不淘汰，尺寸断言失败。

## D4 程序状态记录

```ts
setProgramStatus(status: ProgramStatus): void {
  if (status.state === 'clear' && status.id !== undefined) {
    this.programStatuses.delete(status.id);
  } else {
    this.programStatuses.set(status.id, status);
  }
  if (!this.programStatusSupported) return;
  this.writeProgramStatus(status);
}
```

`stop()` 在写完 clear 序列、重置标志后执行 `this.programStatuses.clear()`。根记录（`id === undefined`）无论 clear 与否都留在表里，行为与现在一致；`confirmProgramStatusSupport` 的遍历重放逻辑不变，表里没有的记录自然不会被重放。

测试（`packages/pi-tui/test/terminal.test.ts`，复用 `setupNegotiation` 的 stdout 打桩）：
- 支持确认后写入 100 个带 id 的记录 + 1 个根记录 → 表尺寸 101。
- 逐个写 clear → 尺寸回落到 1；再写根 clear → 仍为 1。
- 把 `programStatusSupported` 置回 false 后触发重放 → 写出的只有根记录，不含已清理的 id。
- `stop()` → 尺寸 0。

## 疑点测量

### S1 审批面板双渲染

`apps/kimi-code/test/tui/approval-region.bench.ts`（bench-harness）。用真实 `renderDiffLinesClustered` 构造约 1200×1200 行的 diff，stub panel 的 `render(width)` 就是这次 diff 计算；分别 bench `render`、`measure`、`measure+render`。

- 判定规则：`measure+render ≥ 1.5 × render` 且 `measure ≥ 4ms` → 修；否则记录数字、不改。
- 若修：给 `ApprovalRegion` 加按 `width` 缓存的 `body`（`measure` 复用上一帧 `render` 的结果），在 `show/clear/setExpanded/handleKey/handleMouse/handleRawInput/invalidate` 处失效。缓存只在同一宽度、同一内容下命中，不改变任何输出。

### S2 失败路径整段读

`packages/agent-core-v2/test/agent/task/outputSnapshot.bench.ts`（`_support/bench.ts`）。用临时目录 + 16MB `output.log` + 只实现 `size/readStream` 的 `IFileSystemStorageService` 替身，直接构造 `AgentTaskPersistence`，bench `readTaskOutputSnapshot(id, 32KB)` 与 `(id, MAX_SAFE_INTEGER)`。

- 判定规则：全量读 `> 150ms` 或明显内存峰值 → 在失败路径把读取上限收到工具结果的预览大小并附截断说明；否则结论为“受 16MB 上限约束的罕见路径，不改”。
- 说明：成功路径原本就读全量，本次只评估新增的失败调用点。

### S3 shutdown 残留

不写 bench。用一次性探针（`bun -e`，不落盘）创建 `McpConnectionManager`、订阅 3 个监听器、`shutdown()`，读取私有 `operationTails`/`needsAuthTransitions`/`listeners` 的尺寸；再核对唯一调用点：`WorkspaceMcpService` 的 `_register({ dispose: () => void manager.shutdown() })`，随 workspace 实例销毁，之后没有任何 `connect/connectAll` 调用。若 tails 归零、且无复用路径 → 证伪，不改。

### S4 进度定时器

不写文件。用 `bun -e` 起一个只做 `new ProcessTerminal().setProgress(true)` 就返回的进程，加 3s 超时：退出 → 进程不会被定时器拖住；挂住 → 复现。再核对退出路径（`main.ts` 的 `process.exit`、`KimiTUI.stop()` 是否必调）。只有“能挂住且存在不走 stop 的退出路径”才加 `.unref?.()`。

## Bench 设计

两个文件，都把“旧实现”内联在 bench 里（旧代码已删除，无法从 git 之外引用），同一台机器同一次运行内对比：

1. `apps/kimi-code/test/tui/session-stats.bench.ts`
   - 状态：1k / 10k / 50k 步。
   - 指标：`accumulate`（单次累加）、`average`（单次取平均）。
   - 每组用 `bench(..., { iterations })`，旧/新各一行，输出即对比表。
2. `packages/agent-core-v2/test/app/workspaceLifecycle/workspaceLifecycle.bench.ts`
   - 直接 `new WorkspaceLifecycleService(managerStub, sessionManagerStub)`，绕过 DI。
   - 指标：N=100/1000 次 `handlerFor` 的 ms/op，以及 `acquires / disposes / netLeases`。
   - 旧实现（覆盖不释放）与新实现各跑一遍，计数由 stub 提供。

bench 只作为交付证据，不作为 CI 断言；普通测试只断言结构不变量（计数、尺寸、相等性、量级守卫）。

## 提交与 changeset

- 四个 fixes 各一个 changeset（格式参照 `.changeset/mcp-reconnect-backoff.md`）。
- 提交拆分：`fix(agent-core-v2)`（D1）、`fix(agent-core-v2)`（D3）、`fix(tui)`（D2，含 bench）、`fix(pi-tui)`（D4）。benches 随对应 fix 提交。
- **工作树既有未提交改动的处理**：提交前若它们仍在，我会停下来给出三个选项（原样提交为独立 WIP / 只提交我的文件并接受同文件夹带 / 不提交），不擅自把别人的在途改动写进我的提交。

## 被拒绝的方案

- **D2 用滑动窗口或丢样本**：改变读数含义，用户明确禁止。
- **D2 保留数组但缓存平均值**：累加仍是 O(n) 复制，不满足“单次累加不随 step 数增长”。
- **D3 无条件清空 `resumeFailures`**：会破坏 `whenResumeSettled` 的“失败后能抛原错误”。
- **D4 在 `stop()` 里只清子记录**：`setProgramStatus` 仍会累积已结束的 id，问题原样存在。
- **S3 顺手 `listeners.clear()`**：若测量证伪（无复用路径），按 R5 不许改。
- **给测试加 sleep / 宽松阈值**：用户明确禁止；性能只用量级守卫与 bench 证据。

## Assumptions

- `--parallel` 是 `run-package-tests.mjs` 与 `run-tests.mjs` 都接受的转发参数（`DEVELOP.md:515`、`scripts/run-tests.mjs:13`）。
- `bun test <file>` 不经过 runner，因此单文件验证不受 R0.3 的 2 路限制。
- 工作树里既有的 47 个文件改动与本任务无关，且不属于本次交付；提交策略在提交前确认。
- 公开 API 形状、i18n key、UI 文案均不变；`SessionStats` 不属于公开 API（仅 TUI 内部使用）。
