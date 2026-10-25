# Tasks — hello-world staged dev-run mode

执行方式：swarm 子代理分工（现状调查 A / 改动实施 B / 独立核验 C）；产出经独立核验打分后采纳，
不达标打回重做（≤2 轮）。每步标注核验方式与验收证据。既有失败基线见 §5。

## 0. 评分与采纳规则（核验方案）

参考 B 站「Token就是词元」模型乱斗系列做法（同题对照、分组分轮、成败判负、过程可复看、按维度点评），
工程化为三维度评分，对每个实施区域（B1 引擎+SDK / B2 状态链 / B3 TUI / B4 文档）分别打分：

| 维度（0–10，须附证据） | 子项 | 打回线（任一 <8） |
| --- | --- | --- |
| 无回归 | 既有测试不红（对照 §5 基线）；diff 无越权文件；既有行为不变（开关/互斥/其他模式） | 新增红 / 越权改动 / 行为破坏 |
| 无错误 | lint 0 error；check:no-comments 过；typecheck 过；相关 check:* 过；新增测试过；无新报错 | 任一新增报错 |
| 目标正确 | requirements.md 的 A1–A8 逐条有证据（代码位置/命令输出）；与 design.md 契约一致；无死代码/占位残留 | 任一 A 对不上 |

红线一票否决：破坏既有测试、门禁新增报错、删错文件、注释禁区违规、比较字符串本地化、
硬编码密钥、commit 泄露 agent 身份。核验代理只读不改码，与实施代理分离。

## 1. 现状调查（swarm A，只读，3 路并行）

| # | 任务 | 核验方式 | 验收证据 |
| --- | --- | --- | --- |
| A1 | 引擎现状：`features/helloWorld/**` 逐文件现状、contextOps pop、usageEvents、telemetry、index.ts 注册、既有测试断言清单、toolHooks 完整签名 | 我抽查引用 | `.tmp/hello-world-dev-workflow/reports/a1-engine.md` |
| A2 | 状态链现状：transcript contract/meta/foldFacts/apply、kap-server events-zod/ws/coreEventMap、node-sdk types/rpc/session/sdk-rpc-client-v2、sessionLegacy 的 hello-world 字段清单 | 我抽查 | `reports/a2-status.md` |
| A3 | TUI+文档现状：commands/hello-world.ts、registry/dispatch、footer/status-panel/session-event-handler、i18n 键清单、docs 结构、changeset 现状、既有失败基线复测（kimi-tui-message-flow survey ×9 等） | 我抽查 | `reports/a3-tui-docs.md` |

## 2. 实施（swarm B；B1 先行，B2/B3/B4 并行）

| # | 区域 | 任务 | 核验方式 | 验收证据 |
| --- | --- | --- | --- | --- |
| B1 | 引擎+SDK | 按 design.md 契约实现：helloWorld.ts 类型、helloWorldOps（RunUpdated+helloWorldRunKey）、helloWorldService（阶段机+证据推进+移除 veto/自动退出）、注入 7+2 个 md、node-sdk 两个 RPC + SessionStatus、telemetry；更新/新增测试 | `(cd packages/agent-core-v2 && bun run test && bun run typecheck)`、`(cd packages/node-sdk && bun run test && bun run typecheck)` | 测试通过清单 + 关键文件位置 |
| B2 | 状态链 | transcript modes/`hello-world.stage` marker/apply；kap-server events-zod/ws/coreEventMap；sessionLegacy `hello_world_stage`；`bun run gen:manifests` 重生成 | 各包 typecheck+test；manifest diff 只含预期条目 | 命令输出 + diff 摘要 |
| B3 | TUI | 命令子语法（status/next/phase/skip + off 警告）、徽章 `hello-world:<stage>`、`/status` 行、marker、i18n en/zh、message-replay/status-line 载荷 | `(cd apps/kimi-code && bun run typecheck && bun test --isolate <定向>)` | 测试清单 + 截面字段证据 |
| B4 | 文档 | slash-commands zh/en 子命令行与模式说明、新增 guides/hello-world.md（zh/en）、DEVELOP/README fork 列表、改写 `.changeset/hello-world-mode.md` | 我对照 A1–A8 口径复核 | 文档 diff |

## 3. 独立核验（swarm C，只读，3 路并行）

| # | 任务 | 产出 |
| --- | --- | --- |
| C1 | 无回归评分：全量 diff 审查（越权文件/行为路径）+ `bun run test` 与 §5 基线对照；对 B1–B4 各打分 | `reports/c1-regression.md` |
| C2 | 无错误评分：`bun run lint`、`check:no-comments`、各包 typecheck、`check:t-coverage`、`check:locale-keys`、`check:locale-placeholders`、`check:prompt-ownership`、text-as-protocol；对 B1–B4 各打分 | `reports/c2-errors.md` |
| C3 | 目标正确评分：A1–A8 逐条取证（读代码/跑命令），契约一致性、死代码/占位残留检查；对 B1–B4 各打分 | `reports/c3-goal.md` |

## 4. 收尾

| # | 任务 | 核验方式 | 验收证据 |
| --- | --- | --- | --- |
| 4.1 | 打回项重做（如有）并重评 | 第 2 轮得分矩阵 | reports 更新 |
| 4.2 | 终检门禁全家桶（§6）并输出摘录 | 我逐条核对 | 命令输出摘录（含既有失败逐条说明） |
| 4.3 | 写 `specs/mister-terrific-medusa-sentry/progress.md`（进展 + 既有失败与外部阻塞） | — | progress.md |
| 4.4 | 清理 `.tmp/` scratch；commit（conventional commit，无 co-author、无 agent 身份）；立即 push | `git status`/`git log` | commit hash、push 结果（网络不通记外部阻塞） |
| 4.5 | 最终报告：得分矩阵、A1–A8 对照、取舍说明、既有失败与外部阻塞清单 | — | 报告正文 |

## 5. 既有失败基线（核验对照用，均与本次无关）

1. `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts` 9 个 session-rating survey 用例——文件内
   用例污染（单跑/整块跑全绿，HEAD 整跑已红）。
2. 整套并发跑时 `apps/kimi-code/test/cli/v2-run-print.test.ts` 偶发 contention（单跑全绿）。
3. `packages/klient` tsdown 构建在本机失败：`?raw` 加载 os error 123（HEAD 已红）。
4. `apps/kimi-inspect`、`apps/vis/*` typecheck 报 `Cannot find name 'Bun'`（HEAD 已红）。
5. `git push github.com:443` 网络不通（外部阻塞）。
6. `tools/review` 的 zig 产物若不存在，text-as-protocol 无法运行时按外部阻塞记录。

## 6. 门禁命令清单（终检逐条跑）

```
bun run lint
bun run check:no-comments
bun run check:t-coverage
bun run check:locale-keys
bun run check:locale-placeholders
bun run check:prompt-ownership
./tools/review/zig-out/bin/review --check=text-as-protocol
(cd packages/agent-core-v2 && bun run typecheck && bun run test)
(cd packages/transcript && bun run typecheck && bun run test)
(cd packages/kap-server && bun run typecheck && bun run test)
(cd packages/node-sdk && bun run typecheck && bun run test)
(cd apps/kimi-code && bun run typecheck && bun run test)
bun run gen:manifests && git diff --stat packages/agent-core-v2/docs
```

完成定义：B 全部落地、C 三维度全部 ≥8 且无红线、§6 门禁无新增失败（既有失败逐条证明无关）、
A1–A8 逐条有证据、文档一致、scratch 清理、commit+push（或记录外部阻塞）。
