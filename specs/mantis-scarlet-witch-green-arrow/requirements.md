# Requirements — 2.6.3 → 2.7.0 上游对齐收尾

## 目标

把上游 `MoonshotAI/kimi-code` 从 tag `@moonshot-ai/kimi-code@2.6.3`
（`b0de2fbd2de04d87689225aafd3912e5d193b62d`）到 `2.7.0`
（`a5e355e2718a2ebf70d8229fa5a05fe35d5f98a1`）之间的 72 个提交，按
`.upstream/ledger.tsv` 逐条完成判定、落地、探针和证据；不执行整树
`git merge upstream/main`。

完成时同时满足：

1. 72 条提交每条都有 verdict、可执行 probe、可复核 evidence；没有 `-` 探针。
2. 台账中的 `pending`、`in_progress`、`partial` 为 0；`blocked` 有签字并写明卡点。
3. 工作区中属于本次范围的代码、测试、提示词、文档、changeset、CI/构建和包元数据
   按批次落地并提交；未混入与本次范围无关的本地改动。
4. 每个改动都通过对应 Gate；最终按包跑完整测试、构建和 CLI bundle smoke，真实输出
   记入进度。

## 受众

维护本 fork 的开发者，以及在本任务之后接手台账的人。读者应能从 spec 和台账回答：
每条上游提交为什么是这个判定、证据在哪、还剩什么、下一批怎么做。

## 背景事实（2026-11-21 实测）

| 事实 | 证据 |
| --- | --- |
| 区间恰好 72 个提交 | `git rev-list --count b0de2fbd..a5e355e2` → `72` |
| 72 条在台账中都有行 | 按完整 SHA join，72/72 命中 |
| 现有判定：ported 42、equivalent 6、not-applicable 16、pending 7、partial 1 | `.upstream/ledger.tsv` |
| 工作区有大量未提交改动：2839 modified、447 deleted、509 个未跟踪条目（`-uall` 展开为 3105 个文件）、5 staged added | `git status --porcelain -z -uall` |
| `packages/core`、`apps/desktop`、`packages/app-*`、`packages/testkit` 仍未被 Git 跟踪 | `git ls-files` 为 0，`git status` 为 `??` |
| 现有移植已接近完成：`packages/core/src` 114/116 与 2.7.0 逐字节相同；`agent-core-v2/src/agent/loop` 18/21；`kap-server/src` 159/174 | 按 `git ls-tree -r a5e355e2` 逐文件比较 |
| 台账被工作区改动改写了 97 个 evidence 单元格，其中 81 个被覆盖成 `N pass` | `git show HEAD:.upstream/ledger.tsv` 与工作区逐行比较 |
| 工作区台账相对 HEAD 新增 47 行 | 同上 |
| `--verify` 成功时执行 `row.evidence = outcome.detail`，会覆盖原有证据 | `scripts/upstream-ledger.mjs:257-262` |
| 区间内 30 条 ported/equivalent 行使用 `manual:` 探针；全台账 73 条 | 按 probe 前缀统计 |
| 19 条 not-applicable 行没有 `approved_by` 签字 | 按第 9 列统计 |
| 区间内仍有 7 pending、1 partial；另有 2 条区间外但阻塞本区间的行（#4630、#4831） | `.upstream/ledger.tsv` |

当前未闭环行：

- `aced52f218` #4820 — core 抽取；`packages/core` 已存在，剩余是 loop/projection 与模型迁移。
- `b263e80ff3` #4630 — loop runtime 核心；区间外，但 #4820/#4831 依赖它。
- `f538d534cc` #4891 — kap-server sessions/mcp 收敛到 `/api/v1`。
- `2f33641b73` #4963 — 紧凑 session state、全局事件、snake_case。
- `d1fe15f7f8` #5019 — JS/TS 注释门禁。
- `4567ffcf5d` #5023 — 显式 lint 规则与冻结基线。
- `a656ab627a` #5044 — core tool runtime 目录扁平化。
- `f48ae9151a` #5072 — 贡献者指南与 AGENTS.md 校验。
- `2eb3e87c66` #5088 — release title；当前 partial。
- `392505cf57` #4831 — desktop 重试/后台任务；当前 partial，区间外，依赖 #4630。

## 范围

### 纳入

1. 上述 72 个提交的完整 diff：实现、测试、提示词、文档、changeset、CI/构建、包元数据。
2. 台账中 8 条 pending、2 条 partial 的闭环；包括区间外的 #4630、#4831，因为前者是
   #4820 的前置，后者是 desktop 重试/后台任务那条 partial 的剩余部分。
3. 工作区现状的承接：`packages/core`、`apps/desktop`、`packages/app-*`、
   `packages/testkit` 等未跟踪内容，以及 2.7.0 移植带来的修改/删除。
4. 台账证据完整性修复：恢复被覆盖的 evidence，补齐缺失签字，把 closed 行的
   `manual:` 探针换成可执行探针。
5. 按批次的提交与推送，以及最终包级验收。

### 不纳入

- `git merge upstream/main`、`git checkout upstream/main -- .` 或任何整树覆盖。
- 2.6.3..2.7.0 之外的普通上游提交；只处理阻塞台账的 #4630、#4831。
- 版本号 bump、`changeset version`、`publish`、release 分支操作。
- 上游没有的重构、拆分、重命名、分层调整；不把本仓改写成上游的包结构。
- 与本次无关的本地 UI/功能改动；它们留在工作区，不进入本任务的提交。
- 为通过检查而放宽 baseline、跳过硬失败、或用“Bun 没有”“以后再做”“既有遗留”
  作为完成理由。

## 需求

### R1 — 逐条读完上游完整 diff

每个提交都必须用 `git show <sha>` 读完整 diff，不按标题、摘要或
`.tmp/upstream-270-notes.md` 下结论。范围包括实现、测试、提示词、文档、changeset、
CI/构建和包元数据。merge commit 用 first-parent diff（`git show -m --first-parent`
或 `git diff <first-parent> <merge>`）读取实际合并内容，不能因 combined diff 为空而
判定无改动。

### R2 — 读完本地对应实现再改

每条先读本仓对应实现、调用方、测试和本地改造，确认属于原样搬、Bun 翻译、已经等价
还是确实不适用，然后才允许改代码。上游和本地两边都读完之前，不改任何一行。

### R3 — 判定与探针

- verdict 只能取台账枚举：`pending` / `in_progress` / `ported` / `equivalent` /
  `partial` / `blocked` / `not-applicable`。
- `ported` / `equivalent` 必须有 `test:`、`grep:` 或 `absent:` 探针；`manual:` 只允许
  `not-applicable` / `blocked`，且 `approved_by` 非空。
- 72 条中不得有 `probe: -`。
- 每条 evidence 必须能指向具体文件、行、测试名或命令输出；不能只写“已移植”。

### R4 — 保留原有证据，缺什么补什么

已判定为 `ported` / `equivalent` 的行，复核后保留原有 evidence；新增探针结果只能
追加，不能覆盖。工作区中 81 条被覆盖成 `N pass` 的 evidence 必须从 HEAD 恢复并与
新结果合并。

### R5 — not-applicable 必须对着当前树复核

`not-applicable` 必须写明本仓为什么不存在对应目标，并对着当前工作区验证。尤其要
重新检查所有以“本仓没有 `packages/core`”为由的判定：该包现在已经存在，相关后像
可能已经随 core 树落地。桌面相关行同理：`apps/desktop` 已存在，但 workflow/脚本
是否存在要单独核对。

### R6 — 不做上游没有的重构，保留本地能力

不简化、不拆分、不重命名、不调整分层。冲突先记录，再按本仓架构翻译。像 #4820 的
loop/llm/tool 抽取，按 `packages/core` 的现有中间态继续推进，不能只搬一部分就宣称
完成，也不能改写成这个 fork 没有的包结构。

### R7 — Bun node layer

按 `DEVELOP.md` 的 node layer 三条规则和 `.upstream/PLAYBOOK.md` 处理，顺序不能反：
优先 Bun 原生等价 API；没有原生等价实现时落到 Bun 的 `node:*` 兼容层；缺失或降级的
端点登记到 `tools/review/bun-gap-baseline.txt` 并写明替代方案。不得出现
`node foo.mjs`、argv 里的 `"node"` 或 launcher 里的 node 行。
`tools/review/bun-native-baseline.txt` 与 `tools/review/node-launch-baseline.txt`
只能收窄，不能新增条目。

### R8 — Gate

每个改动至少通过：

- 定向 `bun test --isolate <改动对应测试>`；
- 相关包 `bunx tsc --noEmit`；
- `packages/agent-core-v2` 的 `bun run build`（涉及该包时）；
- `bun run check:no-comments`（独立 gate）；
- 改 `package.json` 或新增包：`bun run check:nix-workspace` + `bun install`；
- 改用户可见文案：`check:locale-keys`、`check:locale-placeholders`、
  `check:no-hardcoded-prose`；
- 改 `src/**/*.md` 提示词：按行为变更处理，并在 changeset 说明。

### R9 — 提交与推送

每批验证全绿后，显式 `git add <本批路径>`，禁止 `git add -A`；commit 后推送
`origin main`。提交面只含本批文件与对应台账行。工作区中与本次无关的改动不进入提交。

### R10 — 台账收尾

完成时 `bun scripts/upstream-ledger.mjs --report --ref a5e355e2` 必须输出
`STATUS: clear`，且 `pending`、`in_progress`、`partial` 为 0。`blocked` 只能作为
有签字的例外，且 evidence 写明卡点和缺什么。

### R11 — 不造假台账行

只存在于 release 分支或 tag 的提交按原始 tag diff 处理；不为它伪造主线台账行，
也不用 `--refresh` 把它塞进不属于它的区间。

## 验收

1. 72 条提交逐条出现在审计矩阵（`audit.tsv` 或等价记录）中，含完整 SHA、读过的文件数、
   上游行为、本地对应、判定、探针、evidence。
2. 72 条在台账中 `probe` 均不为 `-`；closed 行的 probe 可执行；`manual:` 只出现在
   有签字的 `not-applicable` / `blocked` 行。
3. 81 条被覆盖的 evidence 全部恢复：原 evidence 文本是新 evidence 的子串；97 个被改
   单元格逐条复核。
4. `bun scripts/upstream-ledger.mjs --report --ref a5e355e2` 输出 `STATUS: clear`。
5. `audit/worktree.tsv` 覆盖 `git status --porcelain -z -uall` 的全部路径；每个路径有分类；
   没有路径未分类。
6. 每个提交批次在 `git show --stat` 中只包含该批 manifest 的路径；推送成功。
7. Gate 命令的真实输出记录在 `progress.md`；最终包级测试、构建、CLI smoke 通过。
