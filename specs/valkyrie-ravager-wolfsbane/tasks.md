# Tasks

顺序与约束见 `requirements.md`，每项技术方案见 `design.md`。任务按 A → B → C 执行；组内任务彼此独立，但 **T5 必须先于 T12**（T5 决定是否删除整条 i18n JSON 管线，而 T12 的 `stale-artifacts` 核对结论依赖同一批路径是否还存在）。

每个任务完成后按 `requirements.md` 的交付物要求汇报：**改动的文件路径 + 执行的验证命令 + 结果**；判定为「不改」的条目给出理由与 `path:line` 证据。

T1–T4、T6–T13 在获批后直接执行。**T5、T9、T10（步骤 2）、T14 含决策点**，决策点在 `design.md` 中标为方案 A/B 或「需用户选择」，执行前需用户选定分支。T15、T16 为收尾。

---

## A 组

### T1 — 修正 `DEVELOP.md` 的 kosong 描述（A1）

改动：
- `DEVELOP.md:182` 重写该段：删除 `src/kosong/` 与「thin re-export」表述；说明 provider/request 代码在 `packages/agent-core-v2/src/human/llm/`、v2 兼容边界是 `src/llm-adapter/`、kosong 是冻结旧内核且 `agent-core-v2` 不得导入。
- `DEVELOP.md:166` 目录注释标注 kosong 为冻结旧内核。

**验收**
1. `grep -n "src/kosong" DEVELOP.md` 无输出。
2. `DEVELOP.md` 关于 kosong 的每处描述与 `docs/en/llm.md:16`、`packages/agent-core-v2/scripts/check-import-boundaries.mjs:141` 不矛盾。
3. 无源码文件改动，因此无需重跑测试。

### T2 — 收敛 kosong 引用面（A2）

改动：
- 删除 `apps/vis/server/package.json:32` 的 `"@moonshot-ai/kosong": "workspace:^"` 与 `apps/vis/server/tsdown.config.ts:11` 的 `deps.neverBundle` 条目。
- 核实 `apps/vscode/tsdown.config.ts:31` 的 kosong alias：若 `apps/vscode/src` 与 `apps/vscode/webview-ui/src` 均无引用则删除，否则保留并说明。
- `packages/kosong/README.md` 顶部加定位段：冻结的 provider 契约来源，只服务已发布 SDK；与 `human/llm` 的规则副本由 `packages/kosong/test/cache-field-parity.test.ts` 对齐；主引擎不导入。

**验收**
1. `cd apps/vis/server && bun run typecheck && bun run build` 均通过；构建产物中不再因该依赖引入 kosong。
2. `grep -rn kosong apps/vis/server/src` 与 `apps/vscode/src`、`apps/vscode/webview-ui/src` 的输出与处置一致（要么为空，要么在汇报中逐条说明为何保留）。
3. `packages/kosong/README.md` 的解释与 `docs/en/llm.md:16,60` 不矛盾。

### T3 — 消除 `apps/kimi-code` 的引擎直连泄漏（A3）

改动：
- `packages/node-sdk/src/index.ts` 增加 `NOTIFY_USER_DELIVERED_OUTPUT` / `NOTIFY_USER_SUPPRESSED_OUTPUT` 的值再导出。
- `apps/kimi-code/src/tui/utils/notify-result.ts:1-4` 改为从 `@moonshot-ai/kimi-code-sdk` 导入；`notifyResultState()` 保持在本文件。

**验收**
1. `grep -rn "agent-core-v2" apps/kimi-code/src/tui` 无输出。
2. `cd apps/kimi-code && bun run typecheck` 通过。
3. `bun run build:packages` 通过，且 `cd packages/node-sdk && bun run build:dts`（api-extractor 公共 API 快照）通过。
4. `cd apps/kimi-code && bunx vitest run --project cli` 中 `tool-call`、`notify` 相关用例通过。
5. 行为无变化（纯导入路径调整），**不需要** changeset。

### T4 — 删除 `tsconfig.json` 过期排除项（A4）

改动：删除 `tsconfig.json:48` 的 `"packages/agent-core"` 行（注意保留 `"apps/kimi-web"` 并处理好逗号）。

**验收**
1. `grep -n "agent-core\"" tsconfig.json` 无输出；`bunx jsonc` 无需，`node -e "require('fs')"` 层面 `tsconfig.json` 仍是合法 JSONC（用 `bunx tsc -p tsconfig.json --noEmit --showConfig > /dev/null` 或 `bun run typecheck` 验证）。
2. `bun run typecheck` 通过（该步会先 `build:packages`，耗时较长）。

### T5 — i18n 收敛（A5）· **决策点**

按 `design.md` A5 选定的方案执行。**前置**：工作树当前已有未提交的 `apps/kimi-code/src/i18n/locales/{en,zh}.json` 改动（`design.md` §A0.2），需先与用户确认这两处改动如何处置（提交 / 丢弃 / 保留），再执行本任务；本任务的所有验收均不得依赖「工作树干净」。

- **方案 A（删除无用管线）**：删 14 个已提交 JSON、`scripts/generate-locale-json.cjs`、`ci.yml:188` 步骤、`stale_artifacts.zig` 的 locale `Generator` 条目与 3 个引用这些路径的 zig 测试、`DEVELOP.md:207` 与 `DEVELOP.md:445` 相关表述、`package.json` 的 `generate:locale-json` 脚本。
- **方案 B（保留并说明）**：仅在 `DEVELOP.md` 与 `packages/i18n/README.md` 写明这些 JSON 无仓库内消费者、保留生成与新鲜度门禁的原因。

**验收（方案 A）**
1. `git ls-files | grep -c 'locales/.*\.json'` = 0，且 `git ls-files | grep -c 'i18n-locales/.*\.json'` = 0。
2. `bun scripts/check-locale-keys.mjs`、`bun scripts/check-locale-placeholders.cjs`、`bun scripts/check-t-call-coverage.mjs` 全部退出码 0。
3. `cd tools/review && zig build test` 通过；`./tools/review/zig-out/bin/review` 仍为 0 error。
4. `grep -rn "generate-locale-json" .github scripts package.json DEVELOP.md docs` 无残留引用。
5. `bun run build` 通过（确认无构建期依赖这些 JSON）。

**验收（方案 B）**：两处文档新增段落存在，且 `ci.yml:188` 的 freshness 步骤与 `review` 均保持通过（注意 `ci.yml:188` 当前因 §A0.2 的未提交改动而为红，方案 B 下应先让该改动提交或回退，再验证为绿）。


---

## B 组

### T6 — 删除孤儿压缩模块 `human/compaction/`（B6 + B7）

改动：
- 删除 `packages/agent-core-v2/src/human/compaction/`（`compaction-instruction.md`、`compaction-summary-prefix.md`、`controller.ts`、`errors.ts`、`machine.ts`、`shape.ts`、`summarize.ts`）。
- 删除 `packages/agent-core-v2/src/human/index.ts:76-79` 四行 `export * from './compaction/*'`。
- 删除 `packages/agent-core-v2/src/human/test/compaction/controller.test.ts`（若该目录随之变空则一并删除目录）。

**验收**
1. `grep -rn "human/compaction" --include='*.ts' packages apps` 无输出（排除 `.contract-types-tmp`）。
2. `grep -rn "compaction-summary-prefix\|compaction-instruction" --include='*.ts' packages/agent-core-v2/src` 只剩 `agent/fullCompaction/` 下的引用；两个 `.md` 在仓库内各只剩 1 份。
3. `cd packages/agent-core-v2 && bun run lint:imports`（= `check:boundaries` + `check:deep-imports`）通过。
4. `bun packages/agent-core-v2/scripts/check-import-boundaries.mjs` 输出 `OK (N files)` 且 N 小于删除前的 1710。
5. `cd packages/agent-core-v2 && bunx vitest run --project agent-core-v2` 全绿；无被删除测试覆盖的行为回退（该模块无生产引用，故只应减少测试数）。
6. `./tools/review/zig-out/bin/review` 无新增 `dangling-refs` / `orphan-exports` 条目。

### T7 — 删除被取代的 `scripts/scan-hardcoded.mjs`（B8）

改动：删除 `scripts/scan-hardcoded.mjs`；`DEVELOP.md:215` 改为单列 `scan-hardcoded-v2.mjs`。

**验收**
1. `grep -rn "scan-hardcoded" --include='*.mjs' --include='*.json' --include='*.yml' --include='*.md' --include='*.zig' . | grep -v zig-cache | grep -v '^./specs/'` 只剩 v2 与 `DEVELOP.md` 的 v2 行。
2. `bun run scan:hardcoded` 仍可运行（退出码与改动前一致）。
3. `review` 无新增 warning。

### T8 — dev 脚本去重（B9 + B10）

改动：
- `apps/kimi-code/package.json:67-69`：保留 `dev:server`，删除 `dev:kap-server`、`dev:kap-server:multi`。
- 根 `package.json:34` 删除 `dev:kap-server`；`:35` 的 `dev:v2` 保留，改为转发到 `dev:server`。
- `apps/kimi-web/DEVELOP.md:54`、`apps/kimi-inspect/README.md:10`：修正对 `dev:v2` / 端口的描述，使其与实际命令一致（先核实 58627/58628 端口是否真实存在；如不存在则如实写明，不臆造）。
- **不重命名** `apps/kimi-code/src/cli/v2/`（理由见 `design.md` §E.3）。

**验收**
1. `node -e` 校验 `apps/kimi-code/package.json` 的 `scripts` 中无两条命令字符串完全相同（改动前有 3 条相同）。
2. `grep -rn "dev:kap-server" --include='*.json' --include='*.md' . | grep -v node_modules | grep -v '^./specs/'` 无输出。
3. `bun run dev:v2 --help`-类等价检查：命令能启动（或至少 `bun run dev:v2` 的解析目标与 `dev:server` 一致，可通过 `bun pm ls`/读脚本比对确认）。
4. 两个 app 的文档描述与实际端口行为一致。

---

## C 组

### T9 — `loopService.ts` 瘦身（C11）· **决策点**

- **方案 A（推荐，纯机械搬移）**：把 `packages/agent-core-v2/src/agent/loop/loopService.ts:2213-2374` 的模块级类型与辅助函数移入新文件 `src/agent/loop/loopInternals.ts`；`loopService.ts` 仅保留 import 与 `AgentLoopService` 类。
- **方案 B（按关注点拆类）**：另行设计，本轮不做。
- **方案 C（放开注释禁令）**：需同时修改 `DEVELOP.md:432` 与 `scripts/check-no-comments.mjs`，属策略变更，本轮不做。

**验收（方案 A）**
1. `wc -l packages/agent-core-v2/src/agent/loop/loopService.ts` < 2150。
2. `git diff --stat` 显示新增 1 个文件、`loopService.ts` 以删除为主，无逻辑改写（新增文件的导出符号名与原模块级声明逐一对应）。
3. `cd packages/agent-core-v2 && bun run lint:imports` 通过；`bun run typecheck` 通过。
4. `bunx vitest run --project agent-core-v2` 全绿且用例数不变。
5. `bun scripts/check-no-comments.mjs` 仍退出码 0（新文件不得引入注释）。

### T10 — 超大文件拆分（C12）· **分两步**

步骤 1（本轮执行）：
- `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`：把 9070 行起的 5 个独立 `describe` 拆到同目录兄弟文件。
- `apps/kimi-code/src/tui/components/messages/tool-call.ts`：把无状态的格式化/解析纯函数移至 `apps/kimi-code/src/tui/utils/tool-call-format.ts`（该 app 已有 `tui/utils/` 惯例）。

步骤 2（只出方案，不执行）：`packages/node-sdk/src/sdk-rpc-client-v2.ts` 的拆分方案 —— 需评估对 `packages/node-sdk/scripts/build-dts.mjs`（api-extractor 公共 API 快照）的影响。

**验收（步骤 1）**
1. `cd apps/kimi-code && bun run typecheck` 通过。
2. `cd apps/kimi-code && bunx vitest run --project cli` 全绿，且**用例总数与拆分前一致**（用 `--reporter=json` 对比 total 数）。
3. `wc -l apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts` 降至约 9100 行以下；新文件的 `describe` 名与原文件逐一相同。
4. `wc -l apps/kimi-code/src/tui/components/messages/tool-call.ts` 明显下降，且该文件不再导出仅由新 utils 使用的纯函数。
5. `git diff` 中不含行为改动（纯搬移）。

### T11 — `human/` 命名说明文档（C13）

改动：新增 `packages/agent-core-v2/src/human/AGENTS.md`，说明 `human/` 是纯内核（非「面向人类」层）、`#human/*` 与 `#/*` 的解析差异（`tsconfig.json` 的 `"#/*": ["./src/*.ts", "./src/human/*.ts"]` 双重映射）、与 `src/agent`、`src/session` 的边界、以及 T6 删除 `human/compaction/` 后的替代模块。

**验收**
1. 文件存在；`md` 不受 `check-no-comments.mjs` 影响（该脚本只扫 `.ts/.tsx/.mts/.mjs`，已核实）。
2. 文档中提到的每个路径/脚本都真实存在（`review` 的 `gate-wiring` 会校验文档声称的门禁；不得出现不存在的脚本名）。
3. 与 `packages/agent-core-v2/src/human/llm/AGENTS.md`、`docs/en/llm.md` 的分层描述一致，无矛盾。
4. `./tools/review/zig-out/bin/review` 无新增 warning。

### T12 — 生成物与运行产物的核对结论（C14）

**无仓库改动**。交付物是一段核对记录，逐条给出证据：

**验收**
1. `git ls-files reports | wc -l` = 0、`git ls-files packages/agent-core-v2/.contract-types-tmp | wc -l` = 0、`git ls-files | grep -c '/dist/'` = 0。
2. 三者在 `.gitignore` 中有对应条目（`.gitignore:2`、`:7`、`:22`）。
3. `git ls-files apps/kimi-code/dist-web | wc -l` = 524，并在记录中标注其为 `DEVELOP.md` 明确的有意提交（「replace, never overlay」）。
4. `./tools/review/zig-out/bin/review` 的 `stale-artifacts` 条目数 = 0。

### T13 — 让 `minidb` 测试可本地运行（C15）

改动：根 `package.json` 增加 `"test:minidb": "cd packages/minidb && bun --bun run vitest run"`；`DEVELOP.md` 测试章节注明 minidb 不在根 `bun run test` 内（沿用 PR #3504 的取舍）及本地运行方式；`tools/review/scripts-wiring-baseline.txt` 追加该条目。

**验收**
1. `bun run test:minidb` 退出码 0。
2. `vitest.config.ts:8` 的 `'!packages/minidb'` **保持不变**（不回退 #3504）。
3. `git diff tools/review/scripts-wiring-baseline.txt` 恰好新增 1 行 `package.json:test:minidb`。
4. `review` 的 `scripts-wiring` warning 数不增加。

### T14 — CI-only 脚本收敛到根 `package.json`（C16）· **含决策点**

改动：
- 新增根脚本 `check:no-comments`（`ci.yml:181` 改为调用它）、`check:locale-placeholders`（`ci.yml:186` 改为调用它）、`check:nix-workspace`、`measure:image-tokens`（手工标定工具）。
- `scripts/check-service-naming.mjs`：**需用户选择**——(a) 删除该死脚本 + `DEVELOP.md:213` 清单行，(b) 新增 `check:service-naming` 根脚本使其可复现。
- 新增的手工脚本追加到 `tools/review/scripts-wiring-baseline.txt`。

**验收**
1. `bun run check:no-comments`、`bun run check:locale-placeholders`、`bun run check:nix-workspace` 的退出码与改动前**逐一同值**。注意 `check-no-comments` 当前为 **exit 1**（§A0.1 的 154 处既有违规），`check:locale-placeholders` 与 `check:nix-workspace` 当前为 exit 0（已实测）。本任务只改变脚本的调用入口，**不修复**既有违规。
2. `grep -n "check-no-comments\|check-locale-placeholders" .github/workflows/ci.yml` 显示改为调用根脚本。
3. 对 `check-service-naming`：按选定分支，(a) `grep -rn "check-service-naming" . --include='*.json' --include='*.yml' --include='*.md' | grep -v node_modules | grep -v zig-cache | grep -v '^./specs/' | grep -v '^./reports/'` 无输出；或 (b) `bun run check:service-naming` 退出码 0。
4. `./tools/review/zig-out/bin/review` 0 error，且 `scripts-wiring` warning 数不高于改动前的 10。

### T15 — `.changeset/` 只读盘点（C17）

**无仓库改动**（不执行 `changeset version`、不删条目）。交付物：按「用户可见 / 非用户可见（docs·test·CI·内部重构）」分类的候选清理清单，供发布窗口使用 `pre-changelog` skill 时参考。

**验收**
1. 清单给出非 README 条目的总数（当前 206）与分类计数，两者相加等于总数。
2. 记录 `bunx changeset status` 的实际输出（当前：8 patch / 7 minor / 1 major）。
3. 引用 `CONTRIBUTING.md:254,257` 说明「本 fork 不开 release PR、发布前手工 prune」是既定流程，因此本轮不做清理。
4. `git status --porcelain` 中 `.changeset/` 无改动。

### T16 — 收尾验证与组级汇报
改动：无（仅必要的 `.changeset` 补充，见下）。

**验收**
1. `bunx oxlint --quiet` 0 error（改动前基线：6893 warning / 0 error，warning 数可微增但需在汇报中说明原因）；`bunx oxfmt --check` 对本轮改动的文件通过（改动前基线：通过）。
2. 与本轮改动相关的验证命令全部执行并在汇报中给出实际结果：`check:boundaries`、`check:deep-imports`、受影响包的 `typecheck`、受影响的 vitest project。
3. `./tools/review/zig-out/bin/review` 0 error，warning 数不高于改动前基线（10）。
4. `bun scripts/check-no-comments.mjs` 的违规数 **不高于 154**（§A0.1 为既有红灯，不作为通过条件；若本轮新增了违规，必须在汇报中说明并修复）。
5. 逐项汇报 A1–A5、B6–B10、C11–C17 的处置（改 / 不改 + 理由），并给出本 spec 中每项验收的实际执行结果。
6. 用户可见行为变更已补 `.changeset/*.md`。**判定**：本轮全部改动为文档、死代码删除、脚本收敛与导入路径调整，**无可观察的用户行为变更**；因此默认**不需要** changeset。若 T8 的 dev 脚本删除被判定为开发者可见行为变更，则补 `@moonshot-ai/kimi-code` patch 说明。另注：`.changeset/README.md` 明确「Test-only, internal refactor, docs, or private debug tooling changes — Usually no changeset needed」。
