# 发现：packages/{minidb,kimi-native-tools,tree-sitter-bash} 下的 .md

范围：`packages/kimi-native-tools/{README,CHANGELOG}.md` + `src/goal/templates/{objective_updated,continuation,budget_limit}.md`（5 个）、
`packages/minidb/{README,DEVELOP,DESIGN_NOTES,CHANGELOG}.md`（4 个）、
`packages/tree-sitter-bash/{README.md,test/fixtures/README.md,test/fixtures/corpus/README.md}`（3 个），共 12 个文件全部通读。

方法：把每份文档里的可验证断言（命令、路径、文件名、数量、默认值、符号名、控制流）逐条回到代码核对；对可疑项实跑只读命令验证
（`node`/`bun` 模块解析、`find dist -name '*.d.ts'`、在 `/tmp` 用最小 cdylib crate 跑 `cargo test`，均未改动仓库文件）。

说明：本范围只有 .md 文件，因此没有「代码注释」类（类别 2）的命中；三个 goal 模板属提示词文本，按类别 3 处理。

## 发现

- `packages/minidb/README.md:362` — 类别 1 · 高 — 说明：文档给出的查询基准重跑命令是 `node bench/query.ts`，但 `bench/query.ts:10` 导入的是 `../src/index.js`，仓库里只有 `src/index.ts`（无 `src/index.js`），实测 `node` 直接报 `ERR_MODULE_NOT_FOUND: Cannot find module '.../packages/minidb/src/index.js'`；同一路径 `bun` 能解析（实测 `bun -e "import('./src/index.js')"` → 成功），即该命令在 Bun 下应写作 `bun bench/query.ts`（依据：`packages/minidb/bench/query.ts:10`）。

- `packages/minidb/README.md:413` — 类别 1 · 低 — 说明：文档写 soak 测试的开关命令是 `SOAK=30 npm run test`，而该测试文件自己的注释写的是 `SOAK=30 bun run test`，仓库统一的脚本运行器也是 bun（依据：`packages/minidb/test/e2e/soak.test.ts:6`、`DEVELOP.md:286`）。

- `packages/kimi-native-tools/src/goal/templates/continuation.md:32` — 类别 3 · 中 — 说明：模板让模型 `call update_goal with status "blocked"`（同文件 `:34`、`:36`、`:39` 同样写法），但该工具的真实名字是 `UpdateGoal`，仓库其他提示词一律用 `UpdateGoal`（依据：`packages/agent-core-v2/src/features/goal/tools/update-goal/updateGoalTool.ts:20`、`packages/agent-core-v2/src/features/goal/goalFeature.ts:45`、`packages/agent-core-v2/src/features/goal/injection/goal-active-reminder.md:14`、`packages/agent-core-v2/src/features/goal/tools/update-goal/update-goal.md:7`）。

- `packages/kimi-native-tools/src/goal/templates/objective_updated.md:16` — 类别 3 · 中 — 说明：模板写 `Do not call update_goal unless the updated goal is actually complete.`，工具名 `update_goal` 不存在，实际是 `UpdateGoal`（依据：`packages/agent-core-v2/src/features/goal/tools/update-goal/updateGoalTool.ts:20`）。

- `packages/kimi-native-tools/src/goal/templates/budget_limit.md:16` — 类别 3 · 中 — 说明：同上，模板写 `Do not call update_goal unless the goal is actually complete.`，实际工具名是 `UpdateGoal`（依据：`packages/agent-core-v2/src/features/goal/tools/update-goal/updateGoalTool.ts:20`）。这三个模板经 `nativeGoalRenderContinuation/BudgetLimit/ObjectiveUpdated` 真实注入模型上下文（依据：`packages/agent-core-v2/src/_base/native-tools.ts:417`、`:431`、`:445`）。

- `packages/kimi-native-tools/README.md:20` — 类别 3 · 中 — 说明：README 声称跑 Rust 单测的命令是 `cargo test --lib`，并断言不加 `--lib` 会「fails on the unsupported doc-test target」；但该包自己的 test 脚本就是 `cargo test`，且实测（cargo 1.99.0 + 最小 cdylib-only crate）`cargo test` 退出码 0、单测正常执行，只有显式 `cargo test --doc` 才报 `error: no library targets found in package`（退出 101）——文档与包脚本互相矛盾，且文档给出的理由在当前工具链下不成立（依据：`packages/kimi-native-tools/package.json:16`、`packages/kimi-native-tools/Cargo.toml:8`）。

- `packages/minidb/README.md:76` — 类别 3 · 中 — 说明：文档称构建产物是「compile src/ -> dist/ (JS + .d.ts)」，但构建配置显式关闭了类型声明输出，`dist/` 里只有 `index.mjs` / `src-*.mjs` / `worker-runtime.mjs`，实测 `find dist -name '*.d.ts'` 零命中（依据：`packages/minidb/tsdown.config.ts:6`）。

- `packages/minidb/README.md:133` — 类别 3 · 低 — 说明：文档称「Index definitions are persisted and rebuilt from the store on startup」，但默认 `indexGenerations: true` 时二级索引是从 generation 镜像加载（定义哈希匹配即 `loadImageAsync`），只有 fallback 路径才从 store 重建——README 自己在 `:526-529` 也是这么写的（依据：`packages/minidb/src/lifecycle.ts:150`、`packages/minidb/src/generation-loader.ts:415`、`packages/minidb/src/generation-loader.ts:417`）。

## 已核对为真、不报告（避免误报）

- minidb README 的 API 表与示例逐条对得上：`MiniDb.open` 选项（`src/types.ts:22-80`）、`openOrRebuild`/`restore`（`src/mini-db.ts:582`、`:1462`）、`ttl` 的 `-1`/`-2` 语义（`src/read-path.ts:105-112`）、`findRange({ min, max, count })`（`src/index-manager.ts:438-459`）、`createCompoundIndex({ groupBy, orderBy, orderType? })`（`src/compound-index.ts:19-22`）、`search(name, q, { op?, limit? })`（`src/text-registry.ts:249-252`）、`createTextIndex` 的 fields 默认「全部字符串」（`src/text-index/tokenize.ts:65-72`）、filter 运算符全集（`src/query.ts:85-153`）、key ≤ 128（`src/value-codec.ts:40`）、`db.lock`（`src/lifecycle.ts:208`）、`BACKUP_IN_PROGRESS`（`src/backup.ts:45`）、read-only 报错文案（`src/mini-db.ts:1589`）、RESP 命令表 12 条（`src/server.ts:137-198`）、`lockHoldMs` 默认 250ms（`src/cluster/index.ts:124`）、`crossShard: 'none'`/`'2pc'` 的拒绝行为（`src/cluster/coordinator.ts:26`、`src/cluster/index.ts:94-96`）、`db.*.tmp` 清理（`src/lifecycle.ts:247-255`）、测试三层目录与 E2E 表 8 个文件（`test/`、`test/e2e/`、`test/cluster/`）。
- minidb DESIGN_NOTES 的帧格式（22 字节头 + 4 字节 CRC、magic "MD"、小端，`src/codec.ts:27-34`、`:137-154`）、skip list `MAX_LEVEL=32`/`P=0.25`（`src/skiplist.ts:7-8`）、`db.text-<name>.postings`（`src/generation.ts:86`）、`db.indexes.json`/`db.textindexes.json`（`src/generation.ts:69-71`）、`recoveryInfo.corruptRanges`（`src/codec.ts:64`）、min-heap TTL（`src/store.ts:56`）、`_rotateLock`（`src/compaction.ts:79`）、`src/worker/` 只有全文构建 worker（`src/worker/`）均属实。
- minidb DEVELOP.md 的符号与数值断言全部属实：`onLockAcquired`（`src/types.ts:42`）、`TextIndexBuildingError`/`basePending`（`src/text-index/index.ts:74`、`:146`）、`TextIndex.baseEpoch`（`src/text-index/index.ts`）、`maybeAutoGenerationBuild` 的 4 MiB 规则（`src/generation-builder.ts:153`、`src/mini-db.ts:1127-1128`）、`buildGeneration('close')`、`readGenerationFileCheckedAsync`/`verifyFileIntegrityAsync`（`src/gen-codec.ts`）、`Store.bulkLoadRefsAsync`（`src/store.ts`）、`walApplySlicer`（`src/generation-loader.ts`）、`LifecycleTracker`（`src/lifecycle-status.ts`）、`maintenanceStatus()`（`src/maintenance.ts`）、`textBuildSlotWaitMs` 默认 30s（`src/maintenance.ts:448`）、`< 4096 docs` 阈值（`src/generation-builder.ts:158`）、`execArgv: ['--experimental-transform-types']`（`src/worker/text-build.ts:129`）、`generations/g-NNNNNN/` + `CURRENT` + format v1（`src/generation.ts:91-92`、`:139`）、`<dir>.ro-scratch/<pid>-*`（`src/mini-db.ts:726`）、`'text-build'` 维护任务（`src/maintenance.ts:29`）、`catchUpFromWal`（`src/mini-db.ts:1527`）。
- tree-sitter-bash README 的 API 与常量全部属实：`SyntaxNode` 形状（`src/node.ts:19-35`）、`descendantsOfType`（`src/node.ts:114`）、默认 50ms/50000 节点与 `timeoutMs: Infinity`（`src/budget.ts:12`、`:23-24`）、`MAX_SUBSTITUTION_DEPTH=150`（`src/parser.ts:87`）、`MAX_PARSE_DEPTH=500`（`src/parser.ts:75`）、`MAX_SCAN_DEPTH=1024`（`src/lexer.ts:99`）、`test/performance.test.ts` 的 <100ms 断言（`test/performance.test.ts:53`）、`test/helpers/known-differences.ts` 与 README 锚点互校（`test/helpers/known-differences.ts:9-11`、`test/differential.test.ts:15-17`）、差分样本 573 条 + corpus known-diffs 23 条（`test/fixtures/differential/*.txt`、`test/fixtures/corpus/known-diffs.txt`）；「换行不进树」实测属实（`parse('echo a\necho b\n')` 与 heredoc 输入均无 `\n` 节点）。
- tree-sitter-bash 两份 fixtures README 的格式说明（`===` 分隔、`@match`/`@known-diff`、`differential/` 八个主题文件、`corpus/known-diffs.txt`、归一化 dump 为前序遍历 + `hasError:` 行）与 `test/differential.test.ts`、`test/helpers/differential.ts` 一致。
- kimi-native-tools README 的构建命令与产物名属实：`bun run build:debug`/`bun run build`（`package.json:13-14`）、五个 target 与 `.node` 命名（`package.json:25-31`，本机存在 `kimi-native-tools.linux-x64-gnu.node`）、`napi artifacts`（`package.json:15`）、`engines.bun >= 1.4.0`（`package.json:33-35`）。
- 刻意不报的弱项：`packages/minidb/README.md:37,76,77,345,394` 的 `npm run build/typecheck/bench`、`npm test` 只是换了脚本运行器，脚本名与 `package.json:47-50` 一一对应，命令本身可用，属弱项（与 `node-era-pass1.md:74` 的判定一致）；`packages/minidb/README.md:331` 的 `node --import tsx src/server.ts` 与 `src/server.ts:289` 的注释一致且 tsx 在根 catalog 中可用，同样不报；`packages/kimi-native-tools/README.md:42` 的「CI should run … for every target」是建议句（实际 `ci.yml:58` 只构建当前平台），非可证伪断言。
