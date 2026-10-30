# Tasks — 审查结论落地

每个任务都可独立完成、独立验证。凡涉及套件的，先跑 R0 预检（`design.md`「测试执行协议」），一次只跑一条。

## T0 预检与单文件基线

- 跑一次进程预检，记录输出（应无 `run-package-tests` / `run-tests.mjs` / `bun test`）。
- 依次跑四个目标测试文件（`bun test <file>`）：workspaceLifecycle、sessionManagerService、session-stats、terminal。
- **验收**：四条命令各自的 pass/fail 记录在案；预检输出为空；没有同时启动第二条命令。

## T1 缺陷 1：验证已落地的修复

- 确认 `workspaceLifecycle.test.ts` 的 `managerStub` 暴露 `liveLeases/minLiveLeases/disposedLeases`，并有串行、并发、dispose 三条用例。
- `cd packages/agent-core-v2 && bun test test/app/workspaceLifecycle/workspaceLifecycle.test.ts`。
- **验收**：17 pass / 0 fail；串行与并发用例里 `acquire=2`、`dispose=1`、`liveLeases=1`、`minLiveLeases=1`。红证据（旧实现 2 条失败、`liveLeases=2`）写进最终交付说明。

## T2 缺陷 1：租约 bench

- 新建 `packages/agent-core-v2/test/app/workspaceLifecycle/workspaceLifecycle.bench.ts`：内联旧实现（覆盖不释放）与新实现（`handlerFor`），共用带计数器的 manager stub；N=100/1000。
- 运行 `cd packages/agent-core-v2 && bun test/app/workspaceLifecycle/workspaceLifecycle.bench.ts`。
- **验收**：输出同时含 ms/op 与 `acquires / disposes / netLeases`；旧实现的 `netLeases = N`，新实现为 1；数字可复制进交付表。

## T3 缺陷 2：红 → 绿

- 先把两个测试夹具改到新字段（`firstTokenTotalMs`/`firstTokenSampleCount`），新增：10k 步严格等于逐样本参考值、1k 与 10k 的 `JSON.stringify` 长度相同、20 万次“累加+取平均”的 10k/1k 耗时比 `< 3`。
- 运行 `bun test apps/kimi-code/test/tui/utils/session-stats.test.ts`，确认在旧实现上失败（尺寸/字段断言或比值）。
- 实现 `types.ts` 与 `session-stats.ts` 的标量版本。
- **验收**：该文件全绿；`bun test apps/kimi-code/test/tui/components/chrome/footer-session-stats.test.ts` 全绿；`firstTokenAverageMs({total: 1800+1600, count: 2}) === 1700`；`JSON.stringify` 长度在 1k/10k 相同；比值实测 < 3。

## T4 缺陷 2：session-stats bench

- 新建 `apps/kimi-code/test/tui/session-stats.bench.ts`：1k/10k/50k 三档，旧实现（数组复制 + 全量 reduce）与新实现各一组，`accumulate` 与 `average` 分开 bench。
- 运行 `cd apps/kimi-code && bun test/tui/session-stats.bench.ts`。
- **验收**：输出含 3 档 × 2 实现 × 2 操作的 ms/op；旧实现随档位线性增长，新实现三档基本持平。

## T5 缺陷 3：红 → 绿

- 在 `sessionManagerService.test.ts` 增加：70 个不同 session 连续 resume 失败 → 表尺寸 ≤ 64、最新 session 的 `whenResumeSettled` 仍抛 `boom`、`dispose()` 后为 0。
- 确认旧实现红（70 > 64）。
- 实现 FIFO 上界（64）与 `dispose()` 清表。
- **验收**：该文件全绿；原「失败传播到下次 settle」用例不变；尺寸断言在旧实现下失败、新实现下通过。

## T6 缺陷 4：红 → 绿

- 在 `terminal.test.ts` 增加：100 个 id + 根记录 → 101；逐个 clear → 1；根 clear 后仍为 1；重放只写根；`stop()` → 0。
- 确认旧实现红（101 不回落）。
- 实现 clear 删除与 `stop()` 清表。
- **验收**：该文件全绿；`PI_PROGRAM_STATUS=0` 与 multiplexer 两条既有用例不变。

## T7 疑点 S1：审批面板双渲染

- 新建 `apps/kimi-code/test/tui/approval-region.bench.ts`，按 `design.md` 的 1200×1200 diff 测 `render` / `measure` / `measure+render`。
- **结论规则**：`measure+render ≥ 1.5×render` 且 `measure ≥ 4ms` → 先加一条「同一帧内 measure 与 render 返回相同行数、且 render 只计算一次」的测试（可用计数 stub），再实现按宽度缓存并失效；否则记录数字，不改代码。
- **验收**：有 bench 输出；有明确结论；若改，新增测试在旧实现上红、新实现绿，且 `status-surface-approval.test.ts` 全绿。

## T8 疑点 S2：失败路径整段读

- 新建 `packages/agent-core-v2/test/agent/task/outputSnapshot.bench.ts`，16MB 日志，测 32KB 预览与全量快照。
- **结论规则**：全量 > 150ms 或明显内存峰值 → 失败路径改收预览并附截断说明（需要新测试）；否则证伪，不改。
- **验收**：有 bench 输出与结论；若证伪，diff 中该路径无改动。

## T9 疑点 S3：shutdown 残留

- `bun -e` 探针：订阅 3 个监听器 → `shutdown()` → 读 `operationTails/needsAuthTransitions/listeners` 尺寸。
- 核对唯一调用点与之后是否存在 `connect/connectAll`。
- **验收**：记录三个尺寸；给出「证伪/要修」结论；证伪则不改。

## T10 疑点 S4：进度定时器

- `bun -e` 探针：只 `setProgress(true)` 后返回，3s 超时判定是否退出；核对退出路径是否必调 `stop()`/`process.exit`。
- **验收**：记录探针结果与退出路径结论；只有「能挂住且存在不走 stop 的路径」才加 `.unref?.()`，并附一条单文件测试。

## T11 changeset

- 四个 `.changeset/*.md`，格式对齐 `.changeset/mcp-reconnect-backoff.md`；写明行为变化、受影响包、以及 D3 的淘汰取舍。
- **验收**：`bun run check:locale-keys` 不因新增文件报错；四个文件各自只描述一个行为变化。

## T12 分阶段验证（严格串行）

按 `design.md` 的表格逐条执行，每条之后记录结果再开始下一条：

1. `cd packages/agent-core-v2 && bun run test --parallel=2`
2. `cd apps/kimi-code && bun run test --parallel=2`
3. `bun run test --parallel=2`（仅一次）
4. `bun run typecheck`
5. `bun run lint`
6. `bun run check:locale-keys && bun run check:status-surface-i18n && bun run check:no-hardcoded-prose && bun run check:no-comments`

- **验收**：六步全绿；每步记录命令、`--parallel` 参数、预检结论；任何一步失败则回到对应任务修复后从该步重跑。

## T13 提交

- 按包拆成 `fix(agent-core-v2)` ×2、`fix(tui)`、`fix(pi-tui)`，benches 随对应 fix。
- 提交前若工作树仍有既有未提交改动，暂停并给出三选一，不擅自混入。
- **验收**：四个提交各自只含本任务文件；没有 `--no-verify`；不推送。
