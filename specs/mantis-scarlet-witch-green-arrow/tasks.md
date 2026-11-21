# Tasks — 2.6.3 → 2.7.0 上游对齐收尾

执行顺序固定：T0 → T1 → T2 → T3，然后 T4…T10 可按依赖并行准备、串行验收入账，
最后 T11 → T12 → T13 → T14。每个任务完成后把命令输出和结论写进
`specs/mantis-scarlet-witch-green-arrow/progress.md`（执行阶段创建）。

## T0 — 工作区清单与分类

产出 `specs/mantis-scarlet-witch-green-arrow/audit/worktree.tsv`。

步骤：

1. `git status --porcelain -z -uall` 取全部路径，逐条登记 `path/status/class/batch/note`。
2. 对 72 条 + `b263e80ff3` + `392505cf57` 取 `git diff-tree -r --no-commit-id --name-only` 并集。
3. 对交集路径比较工作区与上游后像，区分 `port-upstream` / `port-adaptation` /
   `port-metadata`；其余标 `preexisting-unrelated` / `generated` / `ledger-spec`。
4. 创建 `audit/audit.tsv`，表头 `sha  files_read  upstream  local  form  probe  evidence`；
   T4…T10 逐行填充。

验收：

- TSV 行数等于 `git status --porcelain -z -uall` 解析出的记录数（rename 只算一条）。
- 每个路径的 `class` 都在枚举内；没有空 class。
- `git status` 与 T0 开始时相比只多了本 spec 目录下的文件。
- 没有执行 `reset --hard`、`clean`、`restore .`、`checkout upstream/main -- .`。

## T1 — 台账工具：证据只追加

修改 `scripts/upstream-ledger.mjs`：

- 抽出 `appendEvidence(previous, detail)`；
- `verify()` 用它代替 `row.evidence = outcome.detail`；
- `pending`/`in_progress` 成功后推进；`equivalent` 保持；`partial`/`blocked` held。

新增 `scripts/test/upstream-ledger.test.mjs`。

验收：

- `bun test --isolate scripts/test/upstream-ledger.test.mjs` 通过，至少覆盖：
  旧 evidence 保留、重复追加不重复、pending→ported、equivalent 保持。
- 在一个已有 evidence 的受控行上跑 `--verify` 后，`git diff .upstream/ledger.tsv`
  仍包含旧 evidence 原文。
- `bun scripts/upstream-ledger.mjs --report` 正常输出，不因改动报错。

## T2 — 恢复被覆盖的证据

1. 按 HEAD 与工作区台账比较，列出 evidence 变化的行（初始测量 97 个，其中 81 个被
   覆盖成 `N pass`）。
2. 对每行用 `--set <sha> <verdict> --evidence "<old> Probe: <new>"` 写回（单行）。
3. 产出 `audit/ledger-evidence.tsv`：`sha old_len new_len merged`。

验收：

- 初始 81 个 shortened 行，81/81 的新 evidence 包含 HEAD 原文。
- 97 个变化单元格都在 `ledger-evidence.tsv` 中有记录。
- 工作区台账新增的 47 行仍在；没有行被删除。
- `bun scripts/upstream-ledger.mjs --report` 正常。

## T3 — 重判 core 行与 not-applicable 签字

处理 #4998、#5051、#5080、#5044，以及 19 条无签字的 not-applicable。

验收：

- #4998：`absent:createToolExecutor@packages/core/src/tool` 通过（旧入口；不要用
  `ToolExecutorHook`，它在新 core 仍存在）；verdict 不再是 not-applicable。
- #5051：`grep:export function setNow@packages/core/src/utils/now.ts` 与
  `grep:setLog@packages/core/src/utils/log.ts` 通过。
- #5080：`grep:class CallControl@packages/core/src/tool/tool-executor.ts` 通过。
- #5044：`absent:args-validator@packages/core/src/tool` 与
  `grep:export function parseToolCallArguments@packages/core/src/tool/args.ts` 通过。
- 19 条 not-applicable 都有 `approved_by`；每条 evidence 说明“当前树为什么没有目标”，
  并至少用一次 `ls`/`git ls-tree`/`rg` 复核。
- 桌面/web dist/release 相关行逐项复核：`apps/desktop` 存在不等于
  `.github/workflows/desktop-build.yml` 存在；`git ls-tree a5e355e2 apps/kimi-code`
  确认 2.7.0 无 `dist-web`。

## T4 — G1 发布/文档/产物/CI（20 条）

审计：453ba6bb1d f407c52e39 401b4a015f f082f04a09 7052fbbefd 8d939f7dc7
334d79870e 1ccbe4127d d729f91529 391d9e7f4a 6e35efa984 ca14f88807 4d38c0080f
ff61a26074 a5e355e271 2eb3e87c66 374466c66c 71db6b7d38 a4332bec13 6819b036cd。

要求：merge/release sync 用 first-parent diff；tag-only 提交按 tag diff 处理，不伪造
台账行；changelog 用 `grep:` 校验 en/zh 小节；web dist 与 release 分支操作按
`not-applicable` + 签字；CI 行核对本仓是否有对应 workflow 目标。

验收：

- `audit.tsv` 有 20 行；每行 `files_read` 覆盖 `git show --numstat` 的全部路径。
- 20 行 `probe` 均不为 `-`；closed 行探针可执行；not-applicable 有签字。
- 2.6.0/2.6.1/2.6.2/2.6.3 小节在 `docs/en` 与 `docs/zh` 的 changelog 中各存在一次。
- 组内 20 行按 SHA 过滤 `.upstream/ledger.tsv`，verdict 无 pending/in_progress/partial（20/20 closed）。

## T5 — G2 引擎正确性/测试稳定（16 条）

审计：d64909f972 68b849c90d 1364ab4741 1fc7be4001 638c6ffe03 29bc56daaf
6130601871 88e3c20739 b37c9bb857 cab0c0e5ad 50ec3c3940 e5ae24239b 8d7948e111
e122269955 5ae973905c 285584e188。

验收：

- `audit.tsv` 有 16 行；每行读完上游完整 diff 与本地对应实现。
- 涉及 profile binding、subagent timeout、mutable replay、task output tail、usage
  anchored compaction、occupied session resume、Bedrock、Vertex ADC、Bash env、
  Anthropic ceilings 的行都有对应测试或 `grep:` 探针。
- 定向测试在拥有包内通过；`packages/agent-core-v2` typecheck 通过。
- 组内 16 行按 SHA 过滤 `.upstream/ledger.tsv`，verdict 无 pending/in_progress/partial。

## T6 — G3 TUI（8 条）

审计：1ec24a5f51 410814349d 482936afce 1c1544abaf 0ea324cafb 90d3a66c64
a09bf8573c 7e2c565e31。

验收：

- 8 条都有 `audit.tsv` 行；动画 FPS、cron/MCP auth 折叠、prediction、transcript
  trimming、follow_up_behavior、foreground `/tasks`、multiline feedback 都有测试探针。
- 相关测试通过：`running-title`、`transcript-projection`、`kimi-tui-message-flow`、
  `follow-up-preferences`、`tasks-browser`、feedback 相关用例。
- 新增/修改的用户可见文案通过 locale keys/placeholders/no-hardcoded-prose。
- 组内 8 行按 SHA 过滤 `.upstream/ledger.tsv`，verdict 无 pending/in_progress/partial。

## T7 — G4 server/hosts/remote/ACP（15 条）与 #4891/#4963

审计：f538d534cc fec742878d 2f33641b73 13d363e180 b957457968 a692ff9af2
2931c7efd5 de1fdaa89d baa7b4bcfc 84439d5f4e 3a05a7ec93 22d559b089 7057fa3437
44bcf37e2b 0b73b629de。

#4891：逐项分类 15 个 `kap-server/src` 差异；确认 `/api/v1` 会话列表查询、`page_token`、
`by_workspace`、`fields` 投影、MCP 路由收敛。
#4963：确认全局事件收敛、snake_case、`kimi_agent_protocol_version`、订阅重载行为。

验收：

- 15 条 G4 行（含 #4891/#4963）都有 `audit.tsv` 行；15 个 kap-server 差异每个有
  `port-upstream` 或 `port-adaptation` 结论。
- `bun test --isolate` 通过：`sessionList.test.ts`、`mcp.test.ts`、`sessions.test.ts`、
  `sessionEventBroadcaster.test.ts`、`plugins.test.ts`、`config.test.ts`、
  `apiSurface.snapshot.test.ts`（按文件逐一运行）。
- 组内 15 行按 SHA 过滤 `.upstream/ledger.tsv`，verdict 无 pending/in_progress/partial。

## T8 — G5 desktop/apps/testkit/markdown/plugins（5 条）

审计：5db75e0c20 8d426de887 5be33daf1d 63b94bc4c0 08997afe2b。

验收：

- 5 条都有 `audit.tsv` 行；#5079 的 desktop/app-* 抽样与上游一致，差异记录为
  `port-adaptation`；#5078 的 testkit 文件与上游核心文件一致，Vitest 入口已换成 Bun。
- `apps/desktop`、`packages/app-*`、`packages/testkit` 被 workspace/lock 收录；
  `packages/testkit` 的 Bun 测试通过。
- 桌面相关 CI/脚本行用 `ls`/`git ls-files` 确认目标是否存在；不存在则 not-applicable
  + 签字。
- 组内 5 行按 SHA 过滤 `.upstream/ledger.tsv`，verdict 无 pending/in_progress/partial。

## T9 — G6 core 结构与 #4820/#4630/#4831

审计：aced52f218 135993745d 182b324c24 1935082ce7 a656ab627a；区间外
b263e80ff3 392505cf57。

要求：

- 对照 `packages/core/src`（114/116 相同）与 2.7.0；记录 2 个适配。
- 对照 `agent-core-v2/src/agent/loop`（18/21 相同）；记录 3 个适配。
- 确认 `ContextMessage = Message & …`、`machine/*` 删除、`journal.ts`/
  `turnProjection.ts`/`turnUndo.ts` 落地；#4820 不是“只搬包不搬 v2”。
- #4831 的两个可观察修复与 loop 结构复核。

验收：

- `cd packages/core && bun run test` 通过（初始记录 17 files / 164 tests；以实际为准）。
- `cd packages/core && bunx tsc --noEmit` 与 `cd packages/agent-core-v2 && bunx tsc --noEmit` 通过。
- `cd packages/agent-core-v2 && bun run build` 通过。
- loop/subagent/task 定向测试通过；#4820、#4630、#4831 不再是 pending/partial。
- 5 个本地适配写入对应 evidence 和 `.upstream/PLAYBOOK.md`。

## T10 — G7 治理与 #5088

审计：d1fe15f7f8 4567ffcf5d f48ae9151a；处理 #5088。

要求：

- #5019：保留本仓 `scripts/check-no-comments.mjs` 的 3 包 + baseline 策略，判定
  `equivalent`，evidence 写清与上游全仓清理的范围差异。
- #5023：把上游 `scripts/checks` 的规则逐条映射到 `tools/review` / `.oxlintrc.json` /
  baselines；缺的规则加到 `tools/review`，不引入第二套 `scripts/checks`。
- #5072：补一个最小 instructions 校验（所有 AGENTS.md 可解析、必需段落存在），
  带坏 fixture 测试；或证明现有 `check-prompt-ownership.mjs` 已覆盖并给出证据。
- #5088：canary title 已落地；release.yml 的 dormant job 与缺失的 `scripts/release.mjs`
  按 `equivalent` 或 `not-applicable` + 签字处理，不留 partial。

验收：

- `bun run check:no-comments`、`bun run lint`、`./tools/review/zig-out/bin/review` 通过。
- 新 instructions 校验在坏 fixture 上失败、在仓库上通过（若选择新增）。
- #5088 不再是 partial；组内 3 行 + #5088 按 SHA 过滤，verdict 无 pending/in_progress/partial。

## T11 — 台账总收尾

验收：

- 72 条每行 `probe != '-'`；closed 行以 `test:`/`grep:`/`absent:` 开头；`manual:`
  只出现在有 `approved_by` 的 `not-applicable`/`blocked` 行。
- `bun scripts/upstream-ledger.mjs --report --ref a5e355e2` 输出
  `STATUS: clear`，`pending`、`in_progress`、`partial` 均为 0。
- 无重复 SHA、无列数错误；47 条新增行保留。
- 一次性 ledger lint 命令（可在 spec 目录脚本中）输出 72/72、0 个非法 probe、
  0 个无签字 NA。

## T12 — 定向 Gate

验收：

- 每个改动文件对应测试 `bun test --isolate` 通过。
- 相关包 `bunx tsc --noEmit` 通过；`agent-core-v2` 与 `core` build 通过。
- `bun run check:no-comments`、`bun run check:nix-workspace`、
  `bun install --frozen-lockfile` 通过。
- 改文案时三项 locale 检查通过。
- `review --check=bun-native`、`--check=node-launch`、`--check=bun-gap` 通过；
  `git diff tools/review/*baseline.txt` 只收窄或不增。
- 输出记入 `progress.md`。

## T13 — 全量 Gate

验收：

- 按包串行 `bun run test`：引擎、SDK、kap-server、CLI、i18n、core、testkit、
  受影响的 app-* 各一次；记录 files/pass/fail/skip，受本任务覆盖的测试 0 fail。
- `bun run build`；`cd apps/kimi-code && bun run smoke` 通过。
- 改文档时 `bun run build:docs` 通过。
- `git diff --check` 通过。
- flaky 用例有隔离复跑记录与结论；没有靠重试掩盖。
- 输出记入 `progress.md`。

## T14 — 分批提交、推送与最终审计

验收：

- 按 B-A…B-F 分批提交；每批 `git show --stat` 只含该批 manifest 的路径。
- 每批 `git push origin main` 成功。
- 最终 `git status --porcelain` 只剩 `preexisting-unrelated` / `generated` 路径，
  且 `audit/worktree.tsv` 有对应分类。
- 最终报告包含：`--report` 输出、72 条审计矩阵、Gate 输出、未完成/风险（如有）。
- 没有版本号 bump、没有发布、没有把无关改动混入提交。
