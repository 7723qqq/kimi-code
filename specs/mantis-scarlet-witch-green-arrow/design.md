# Design — 2.6.3 → 2.7.0 上游对齐收尾

## 总览

```
工作区现状（未提交的移植）
        │
        ├─ 0.1 清单与分类 ──► audit/worktree.tsv
        ├─ 0.2 修台账工具（证据只追加）
        ├─ 0.3 恢复 81 条被覆盖的 evidence
        ├─ 0.4 重判 packages/core 出现后失效的 not-applicable
        └─ 0.5 把 30 条 closed 行的 manual 探针换成可执行探针
        │
        ▼
72 条逐条审计（G1…G7）──► audit.tsv 每行有完整 SHA、读过的文件数、判定、探针、evidence
        │
        ▼
未闭环行（#4820 #4630 #4891 #4963 #5019 #5023 #5044 #5072 #5088 #4831）
        │
        ▼
Gate（定向 → 包级 → 全量）──► 分批 commit/push ──► --report STATUS: clear
```

三个不可交换的顺序：

1. 先修台账工具，再跑任何 `--verify`；否则继续覆盖证据。
2. 先分类工作区，再 `git add`；否则会把无关 UI 改动混进批次。
3. 先读完上游和本地两侧，再改代码；否则会把“看起来像”当成“已经等价”。

## 阶段 0 — 基线、证据修复、重判

### 0.1 工作区清单与分类

产出 `audit/worktree.tsv`（spec 目录内，执行阶段创建），列：

```
path  status  class  batch  note
```

`class` 取值：

- `port-upstream`：路径出现在 72 条提交（或 #4630/#4831）的 diff 中，内容按上游后像落地。
- `port-adaptation`：同一路径的本地改写，属于 Bun/Windows/本仓架构适配。
- `port-metadata`：`package.json`、`bun.lock`、`flake.nix`、`tsconfig`、workspace 注册等。
- `preexisting-unrelated`：与本次范围无关的本地 UI/功能改动，保留但不提交。
- `generated`：`dist-web`、native 产物、图标构建产物等。
- `ledger-spec`：`.upstream/ledger.tsv`、`.upstream/PLAYBOOK.md`、本 spec。

生成方式：

1. `git status --porcelain -z -uall` 取全部路径，逐条登记；数量必须与解析出的记录数（rename 只算一条）相等。
2. 对 72 条逐个 `git diff-tree -r --no-commit-id --name-only <sha>` 取并集；merge
   commit 用 `git diff <first-parent> <merge> --name-only`，不能因 combined diff 为空
   而漏路径。再加 `b263e80ff3`、`392505cf57` 和根元数据文件。
3. 对交集内的每个路径，用 `git show <sha>:<path>`（或提交后像）与工作区比较，区分
   `port-upstream` 与 `port-adaptation`；记录差异原因。
4. 不在并集内、但被本任务需要的文件（如本 spec、台账工具、测试）标为 `ledger-spec`；
   其余标为 `preexisting-unrelated` 或 `generated`。

禁止：`git reset --hard`、`git clean`、`git restore .`、`git checkout upstream/main -- .`。
工作区是上一轮移植的成果，本任务承接而不是丢弃。

### 0.2 修台账工具：证据只追加

现状：`scripts/upstream-ledger.mjs` 的 `verify()` 在探针成功时执行
`row.evidence = outcome.detail`（约 260 行），把详细证据覆盖成 `N pass`。

改动：

1. 抽出纯函数 `appendEvidence(previous, probeDetail)`：
   - `previous` 为空或 `-` 时返回 `probeDetail`；
   - 已包含同一 `Probe: <detail>` 时不重复追加；
   - 否则返回 `${previous} Probe: ${probeDetail}`（台账是 TSV，evidence 必须保持单行）。
2. `verify()` 改为调用该函数；已 closed 的行保留原 verdict，只推进
   `pending` / `in_progress`。`partial` / `blocked` 继续 held。
3. 给脚本底部入口加 `if (import.meta.main)` 守卫，使纯函数可被测试导入；
   不改变命令行行为。
4. 新增 `scripts/test/upstream-ledger.test.mjs`，至少覆盖：
   - 旧 evidence 保留且新结果追加；
   - 重复追加不产生重复行；
   - `pending` 行成功后推进为 `ported`；
   - `equivalent` 行保持 `equivalent`。
5. 不新增依赖；只用 `bun:test`、`node:fs`、`node:path`。

验收：在受控行上跑 `--verify`，`git diff .upstream/ledger.tsv` 中旧 evidence 文本仍在。

### 0.3 恢复被覆盖的证据

用 HEAD 的台账与工作区逐行比较，得到 97 个 evidence 变化的行；其中 81 个新值匹配
`^\d+ pass$`。对每一行：

1. 取 HEAD 的 `evidence` 文本；
2. 取工作区的新值（探针输出）；
3. 用 `--set <sha> <verdict> --evidence "<old> Probe: <new>"` 写回（单行）；已 closed 行允许
   这样写，`--set` 只在 `pending` / `in_progress` 且已有可执行探针时拒绝；
4. 对 verdict 也变化的行，先记录旧 verdict，再按 0.4/阶段 1 的结论决定。

验收：81/81 行的 HEAD evidence 是新 evidence 的子串；97 个变化单元格都有合并记录；
新增的 47 行不被删除。

### 0.4 重判 `packages/core` 出现后失效的行

`packages/core` 已在工作区存在且被 `bun.lock`/workspace glob 收录，原先以“本仓没有
packages/core”为由的判定必须复核：

| 行 | 现状 | 处理 |
| --- | --- | --- |
| #4998 `135993745d` | 旧 verdict `not-applicable`；`packages/core/src/tool/{contract,executor,hooks,policy,tool}.ts` 已不存在 | 改为 `ported`/`equivalent`；`absent:createToolExecutor@packages/core/src/tool`（旧入口），并补 `grep:` 新执行器。不要用 `ToolExecutorHook`：它在新 core 的 `types.ts` 里仍然存在 |
| #5051 `182b324c24` | 旧 `not-applicable`；`utils/now.ts`、`utils/log.ts` 存在 | `grep:export function setNow@packages/core/src/utils/now.ts`、`grep:setLog@packages/core/src/utils/log.ts` |
| #5080 `1935082ce7` | 旧 `not-applicable`；`tool/tool-executor.ts` 有 `CallControl` | `grep:class CallControl@packages/core/src/tool/tool-executor.ts` + 核心执行器测试 |
| #5044 `a656ab627a` | `pending`；`tool/runtime` 不存在，`args.ts`/`validate.ts` 已扁平化 | `absent:args-validator@packages/core/src/tool` + `grep:export function parseToolCallArguments@packages/core/src/tool/args.ts` |

同时：

- 重新核对桌面相关 `not-applicable`：`apps/desktop` 存在，但
  `.github/workflows/desktop-build.yml`、`scripts/desktop-nightly-guard.mjs`、
  `scripts/canary-version.mjs`、`scripts/release.mjs` 是否存在要逐项 `ls`/`git ls-files`。
- 重新核对 web dist 相关 `not-applicable`：`git ls-tree a5e355e2 apps/kimi-code` 确认
  2.7.0 没有 `dist-web`；fork 自带的 bundle 是本地策略。
- 给 19 条没有签字的 `not-applicable` 补 `approved_by`；签字内容说明“目标不存在”的
  事实和适用边界，不伪造上游行为。

### 0.5 把 closed 行的 manual 探针换成可执行探针

区间内 30 条 `ported`/`equivalent` 行使用 `manual:`。按类型替换：

| 类型 | 例 | 探针 |
| --- | --- | --- |
| 代码修复/功能 | #4878、#4890、#5053 | `test:<现有测试路径>#<用例名>`；没有现成用例就补一条 `bun:test` |
| 文档/changelog | #4872、#4912、#4929、#5022 | `grep:<小节标题或正文>@docs/{en,zh}/release-notes/changelog.md` |
| release squash | #5026、#4930 | 对已落地的用户可见符号做 `grep:`（如 `searchUrl`、`feedbackUrl`、`empty-response`、`sessionIndex`）；只有确实没有目标时才转 `not-applicable` + 签字 |
| desktop 导入 | #5079 | `grep:`/`test:` `apps/desktop` 或 `packages/app-*` 的关键文件/用例 |
| remove-only | #5087 | `absent:<被删除的字符串>@<路径>` |
| CI/发布 | #4821、#5088 | `grep:` workflow 键；本仓没有 release 分支或 release job 的，转 `not-applicable` + 签字 |

替换后 `manual:` 只出现在 `not-applicable` / `blocked` 行。探针统一用
`bun scripts/upstream-ledger.mjs --probe <sha> <probe>` 登记，再按 0.2 修好的
`--verify` 跑；evidence 用 0.3 的合并结果。

## 阶段 1 — 72 条逐条审计

### 每条协议

1. `git show --stat <sha>` 取文件面；`git show <sha>` 读完整 diff。
2. 大提交按文件组分页读（#4820 501 文件、#5079 1448 文件、#4891 104 文件、
   #4963 46 文件），每组记录读了哪些文件；`audit.tsv` 的 `files_read` 必须覆盖
   `git show --numstat` 的全部路径。
3. merge commit 用 first-parent diff；release sync 读实际合并内容。
4. 读本地对应实现、调用方、测试、本地改造；记录“原样搬 / Bun 翻译 / 已等价 /
   不适用 / 需修”。
5. 需要改代码时，先加/改 `bun:test` 覆盖行为，再改实现；跑定向 Gate。
6. 选探针，`--probe` 登记，`--verify` 或手工跑通，`--set` 合并 evidence。
7. 在 `audit.tsv` 写一行：`sha  files_read  upstream   local   form   probe   evidence`。

### 分组

| 组 | 条数 | 提交（10 位 SHA） |
| --- | --- | --- |
| G1 发布/文档/产物/CI | 20 | 453ba6bb1d f407c52e39 401b4a015f f082f04a09 7052fbbefd 8d939f7dc7 334d79870e 1ccbe4127d d729f91529 391d9e7f4a 6e35efa984 ca14f88807 4d38c0080f ff61a26074 a5e355e271 2eb3e87c66 374466c66c 71db6b7d38 a4332bec13 6819b036cd |
| G2 引擎正确性/测试稳定 | 16 | d64909f972 68b849c90d 1364ab4741 1fc7be4001 638c6ffe03 29bc56daaf 6130601871 88e3c20739 b37c9bb857 cab0c0e5ad 50ec3c3940 e5ae24239b 8d7948e111 e122269955 5ae973905c 285584e188 |
| G3 TUI | 8 | 1ec24a5f51 410814349d 482936afce 1c1544abaf 0ea324cafb 90d3a66c64 a09bf8573c 7e2c565e31 |
| G4 server/hosts/remote/ACP | 15 | f538d534cc 2f33641b73 13d363e180 b957457968 a692ff9af2 2931c7efd5 de1fdaa89d baa7b4bcfc 84439d5f4e 3a05a7ec93 22d559b089 7057fa3437 44bcf37e2b 0b73b629de fec742878d |
| G5 desktop/apps/testkit/markdown/plugins | 5 | 5db75e0c20 8d426de887 5be33daf1d 63b94bc4c0 08997afe2b |
| G6 core 结构 | 5 + 2 | aced52f218 135993745d 182b324c24 1935082ce7 a656ab627a；区间外阻塞项 b263e80ff3 392505cf57 |
| G7 治理 | 3 | d1fe15f7f8 4567ffcf5d f48ae9151a |

### 已验证的本地适配（保留，不改回上游）

逐文件比较的结果：`packages/core/src` 114/116 相同、`agent-core-v2/src/agent/loop`
18/21 相同、`kap-server/src` 159/174 相同。已确认的适配：

- `packages/core/src/llm/transport/headers-timeout.ts`：`undici/index.js` 深导入 + 类型
  断言，适配本仓依赖解析。
- `packages/core/src/tool/output-store.ts`：`TOOL_OUTPUT_CLOSED` 常量 + ENOENT 祖先
  目录判断，适配 Windows/删除竞态。
- `packages/agent-core-v2/src/agent/loop/llmRequestOps.ts`、
  `requestObservation.ts`：`Bun.CryptoHasher` 替代 `node:crypto.createHash`。
- `packages/agent-core-v2/src/agent/loop/loop.ts`：删除注释，符合零注释区规则。

这些差异要写进对应行的 evidence 和 `.upstream/PLAYBOOK.md`，不当作缺口。

## 阶段 2 — 未闭环行

| 行 | 现状 | 做法 | 完成判据 |
| --- | --- | --- | --- |
| #4820 `aced52f218` | pending；core 树已在，loop/projection 与模型迁移也在工作区 | 对照 2.7.0 `packages/core`（114/116）和 `agent-core-v2` 的 `contextMemory/types.ts`、`loop/*`、`undo/turnUndo.ts`；确认 `ContextMessage = Message & …` 已统一；补 core 测试与包注册证据 | `packages/core` 测试通过；agent-core-v2 typecheck/build 通过；行改 `ported`/`equivalent` |
| #4630 `b263e80ff3` | pending；区间外 | 对照 loop 21 文件（18 相同）与 3 个适配；确认 `machine/*` 已删、`journal.ts`/`turnProjection.ts`/`turnUndo.ts` 已落 | loop 相关测试通过；行改 `ported`/`equivalent` |
| #4891 `f538d534cc` | pending；kap-server 159/174 相同 | 逐项分类 15 个差异：`sessionList.ts`、`routes/mcp.ts`、`sessions.ts`、`sessionsAcrossHosts.ts`、`instanceRegistry.ts`、`version.ts`、`conversationFeed.ts`、`conversationFold.ts`、`hostProviders.ts`、`sessionTaskFeed.ts`、`promptMedia.ts`、`prompts.ts`、`search/*`、`services/workspaceVisibility.ts`；确认 `/api/v1` 路由、`page_token`、`by_workspace`、`fields` 投影 | `sessionList.test.ts`、`mcp.test.ts`、`sessions.test.ts`、`apiSurface.snapshot.test.ts` 通过；行闭环 |
| #4963 `2f33641b73` | pending | 对照 `sessionEventBroadcaster.ts`、`events.ts`、`sessionAgentFeed.ts`、`agentState.ts`、`routes/plugins.ts`、`sessions.ts`；确认全局事件收敛、snake_case、`kimi_agent_protocol_version` | `sessionEventBroadcaster.test.ts`、`plugins.test.ts`、`config.test.ts`、`wsConnectionV1.test.ts` 通过 |
| #5019 `d1fe15f7f8` | pending | 上游 `scripts/check-comments.mjs` 是全仓注释清理；本仓 `scripts/check-no-comments.mjs` 只覆盖 3 个零注释区 + baseline。保留本仓策略，判定 `equivalent`，evidence 写明范围差异 | `bun run check:no-comments` 通过；`grep:` 证明 3 个包和 baseline 存在 |
| #5023 `4567ffcf5d` | pending | 上游 `scripts/checks/{registry,ratchet,guards}.json`；本仓对应 `tools/review` + `.oxlintrc.json` + baselines。逐条映射；缺的规则加到 `tools/review`，不引入 `scripts/checks` 第二套 | `./tools/review/zig-out/bin/review` 与 `bun run lint` 通过；evidence 列出映射 |
| #5072 `f48ae9151a` | pending | 上游 `scripts/checks/instructions.mjs`；本仓 `scripts/check-prompt-ownership.mjs` 只校验 AGENTS.md 的少数断言。把“所有 AGENTS.md 可解析且必需段落存在”的最小校验落到 `tools/review` 或现有 check，并加坏 fixture 测试 | 新 check 通过仓库、拒绝坏 fixture；行闭环 |
| #5088 `2eb3e87c66` | partial | canary 半已落地；release.yml 的 `kimi-release` 是 dormant，`scripts/release.mjs` 不存在。按 `equivalent` 记录“canary 已移植，release 半无目标”，或按 `not-applicable` 加签字；不留 partial | `grep:` canary title；`absent:` `scripts/release.mjs`；`--report` 无 partial |
| #4831 `392505cf57` | partial；区间外 | 复核 `SubagentActivityStore` 去重、失败尝试 usage/messageId/timing、task feed 无轮询；#4630 落地后确认 loop 结构已齐 | `subagent-activity-store.test.ts`、`loop.test.ts`、`taskService.test.ts`、`sessionTaskFeed.test.ts` 通过；行改 `ported` 或 `equivalent` |

## 阶段 3 — Gate 与提交

### 定向 Gate

| 触发 | 命令 |
| --- | --- |
| 任何代码 | `bun test --isolate <改动测试>`（在拥有包目录运行） |
| 任何代码 | `bunx tsc --noEmit`（相关包） |
| agent-core-v2 | `cd packages/agent-core-v2 && bun run build` |
| packages/core | `cd packages/core && bun run test && bunx tsc --noEmit` |
| 任何代码 | `bun run check:no-comments` |
| 新包/package.json | `bun run check:nix-workspace && bun install` |
| 用户可见文案 | `bun run check:locale-keys && bun run check:locale-placeholders && bun run check:no-hardcoded-prose` |
| 提示词 | 按行为变更写 changeset，并跑 prompt/ownership 相关检查 |
| 结构 | `./tools/review/zig-out/bin/review`（必要时先 `cd tools/review && zig build`） |
| Bun 翻译 | `review --check=bun-native`、`--check=node-launch`、`--check=bun-gap`；baseline 只收窄 |

### 最终 Gate

- 按包串行 `bun run test`（根 `scripts/run-tests.mjs`，一次一个包），引擎、SDK、
  kap-server、CLI、i18n、core、testkit、app-* 各跑一次；记录文件数、pass/fail/skip。
- `bun run build`；`cd apps/kimi-code && bun run smoke`。
- 改文档时 `bun run build:docs`。
- `git diff --check`；`git status --porcelain` 只应剩下 `preexisting-unrelated` /
  `generated` 路径。

### 提交批次

批次按提交组划分；manifest 是“本组 72 条提交的路径并集 − 已由更早批次提交的路径”。
如果两条提交改同一文件，后一条并入先落地的批次，不把一个文件拆成两次提交。

| 批次 | 内容 | 关键路径 |
| --- | --- | --- |
| B-A | 台账工具与证据修复 | `scripts/upstream-ledger.mjs`、`scripts/test/upstream-ledger.test.mjs`、`.upstream/ledger.tsv`、`.upstream/PLAYBOOK.md` |
| B-B | core + loop + 结构行 | `packages/core/**`、`packages/agent-core-v2/src/agent/{loop,contextMemory,undo}/**`、根 `package.json`、`bun.lock`、`flake.nix` |
| B-C | server/hosts/remote/ACP/KAP | `packages/kap-server/**`、`packages/klient/**`（promptPrediction 契约除外）、`packages/remote-control/**`、`packages/acp-server/**` |
| B-D | TUI | `apps/kimi-code/src/tui/**`、`apps/kimi-code/test/**`、`packages/klient` 的 promptPrediction 契约、对应 locale |
| B-E | desktop/apps/testkit | `apps/desktop/**`、`packages/app-*/**`、`packages/testkit/**`、桌面资源/脚本 |
| B-F | 治理/文档/CI | `scripts/check-no-comments*`、`tools/review/**`、`docs/**`、`.github/workflows/**`、`.changeset/**` |

每批：`git status` 核对 → 显式 `git add <manifest>` → `git diff --cached --stat` 复核 →
commit（`type(scope): 祈使句`，不带 co-author）→ `git push origin main`。

台账是单个文件，无法按批部分暂存，因此 B-A 提交修复后的完整快照（含已复核的
evidence），后续批次只在该批确实改变 verdict/evidence 时再更新台账；代码批次与台账
快照在同一次 push 序列中落地，最终以 T11 的 `--report` 为准。若某条代码在后续批次
才提交，B-A 的 evidence 必须写成“工作区已存在、随 B-x 提交”，不能暗示它已在 HEAD。

## 替代方案（已拒绝）

1. **整树 `git merge upstream/main`**：工具链已分叉，历史冲突 638 处；现有
   `specs/upstream-sync-ledger/design.md` 已明确不做。
2. **`git checkout upstream/main -- .` 整树覆盖**：会覆盖本仓的 Bun/Windows 适配、
   本地独有能力以及工作区里未提交的移植，且无法按台账逐条负责。
3. **reset/clean 后从零重搬**：工作区已经包含接近完成的移植（core 114/116、
   loop 18/21、kap-server 159/174），重搬会丢掉已验证的工作并扩大风险。
4. **保留 `manual:` 探针，只清 verdict**：违反 R3/R8 和用户对“可执行 evidence”的要求。
5. **把上游 `scripts/checks/*` 整套导入**：会形成第二套检查系统，与本仓
   `tools/review` 漂移；只映射缺失规则。
6. **把剩余 pending 标 `blocked` 清账**：用户明确禁止用“以后再做/既有遗留”完成；
   `blocked` 只用于真实卡点且有签字。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| 工作区混有无关 UI 改动 | 0.1 分类 + 每批 manifest + `git diff --cached` 复核；不 `git add -A` |
| 再跑 `--verify` 覆盖证据 | 先做 0.2；恢复后再 verify；每次 verify 后检查 evidence 子串 |
| 新包未注册导致 typecheck/build 失败 | `packages/*`/`apps/*` glob 已覆盖；跑 `bun install`、`check:nix-workspace`、`bun.lock` 核对 |
| Windows/Bun 差异（ENOENT、路径、watcher） | 沿用 core `output-store.ts`、agent-core-v2 既有适配；测试在 Windows 上跑 |
| 大提交读不全 | 按文件组分页，`audit.tsv` 记录 `files_read` 与总数；不凭摘要下结论 |
| 测试 flaky | 复跑并定位；不靠重试掩盖；记录 flaky 观察 |
| CLI 整包被无关 UI 拖红 | 先在起点 commit 的临时 worktree 上复现：能复现且路径不在本批 manifest 内，记录为“与本任务无关的既有失败”并隔离；不能复现则视为本任务引入，必须修。不能把前者写成“本任务全绿”，也不能把后者用“既有遗留”放行 |
| API snapshot 漂移 | `apiSurface.snapshot.test.ts` 与 openapi 测试同批更新 |

## 假设

- 工作区当前内容就是上一轮 2.7.0 移植的成果，本任务承接并验证，不丢弃。
- 用户在批准本 spec 时同时批准按批 commit 与 `git push origin main`。
- 不 bump 包版本、不发布；`a5e355e271` 只作为范围终点和 release 记录审计。
- `packages/core` 是本仓采用的中间态；不改成上游没有的包结构。
- 区间固定为两个 tag SHA；区间外的 #4630/#4831 只作为台账阻塞项处理。
