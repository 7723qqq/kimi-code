# Requirements — kimi-code 代码库结构化说明（只读分析）

## 1. 目标

产出一份**中文的、结构化的、可核实的**代码库说明，回答用户提出的五个问题：

| 编号 | 用户问题 | 对应交付章节 |
| --- | --- | --- |
| Q1 | 项目整体结构与技术栈（语言、框架、依赖） | 第 1 章 |
| Q2 | 主要目录和模块，以及各自的职责 | 第 2 章 |
| Q3 | 关键入口、核心流程与模块之间的调用关系 | 第 3 章 |
| Q4 | 如何构建、运行和测试（以仓库配置和脚本为准） | 第 4 章 |
| Q5 | 值得注意的部分（复杂度高 / 不够清晰） | 第 5 章 |

成功判据：一个没读过本仓库的工程师读完这份文档后，能（a）说清产品由哪几个可执行形态组成；（b）在给定一个需求时指出该改哪个 workspace、哪个目录；（c）照着第 4 章能跑起来，且知道哪条路是**当前实际可用**的（例如 `dev:cli` 已断裂）。

## 2. 受众

- 接手本仓库的人类工程师 / 评审者。
- 后续 AI 会话：作为进入本仓库时的上下文文档（因此事实必须自带可核实的锚点，而不是"看起来合理"的叙述）。

## 3. 交付物与落点

- 落点：**只写入** `specs/domino-hawkgirl-dazzler/`。
- 不新增、不修改仓库中任何其他文件；不修改任何代码。
- 交付物语言：中文叙述 + 英文标识符（包名、路径、命令、符号名保持原样）。

## 4. 边界（必须满足）

- **R1 只读。** 除 spec 目录外，工作区文件内容不得改变。判定：`git status --porcelain` 的输出中不出现 spec 目录以外的路径。
- **R2 覆盖全部工作区成员，同等深度。** 根 `package.json` `workspaces` 展开后的 26 个成员，每个都要有：包名/版本、职责一句话、关键目录或文件、被谁依赖或依赖谁。判定：文档中出现的成员名集合 == `workspaces` 展开后的集合（含 `apps/kimi-web` 的例外说明）。
- **R3 事实可核实。** 每条"代码事实"必须携带仓库相对路径（必要时带符号名）；路径必须真实存在。判定：抽取文档中所有反引号包裹的 `packages/...` / `apps/...` / `scripts/...` 路径，逐个 `test -e`，失败数为 0。
- **R4 数字可复现。** 文档中出现的每个计数（文件数、行数、模块数、命令数、作业数）必须同时给出产生它的命令，且该命令可重跑得到同一数字（允许 ±0，只读命令）。
- **R5 区分事实与声称。** 来自 `DEVELOP.md` / `README.md` 等文档的结论要标注为"文档声称"；未能从代码确认的项进入附录"未展开 / 存疑"，不得混入正文当作事实。
- **R6 不执行写操作。** 不运行 `bun run build`、`bun run test`、`bun install`、`bun run typecheck` 等会写 `dist/`、`node_modules/` 或缓存的命令；只用只读命令（`ls` / `find` / `wc` / `grep` / `git log` / `git status`）。
- **R7 引用而不复制全局规则。** 不把 `DEVELOP.md` 的规范条目抄进本文档；只引用文件与章节位置，避免规则移动后本文档过期。

## 5. 明确不做（out of scope）

- 任何代码修改、重构、修复（包括"顺手改一下"）。
- 对 fork 与 upstream 做完整 diff（只在第 5 章点出可核实的结构性差异）。
- 性能基准、内存分析、真实运行截图。
- 重新绘制架构图（文本/表格描述即可，不产出图片）。
- 把 `reports/`、`参考目录/` 的内容当作权威事实来源（它们只是现场痕迹，可作为"存在性"证据）。
- 评估代码质量优劣并给出改造方案——第 5 章只做**现象描述 + 证据 + 影响面**，不给方案。

## 6. 已知的、必须写进文档的硬事实（调研已确认）

以下为调研阶段已确认、需在文档中如实呈现的项，避免交付物退化为泛泛而谈：

1. 根 `package.json`：`@moonshot-ai/monorepo@0.1.1`，`packageManager: bun@1.4.2`，workspaces 含 `packages/*`、`apps/*`、`!apps/kimi-web`、`apps/vis/server`、`apps/vis/web`、`docs`。
2. `apps/kimi-code` 是主 CLI/TUI（`@moonshot-ai/kimi-code@2.1.1`）；入口链 `src/main.ts` → `src/cli/commands.ts` → `src/cli/run-shell.ts` → SDK `KimiHarness` → `src/tui/kimi-tui.ts`。
3. 引擎是 `packages/agent-core-v2@0.4.3`（DI × Scope），约 29 万行 TS，是仓库体量的主体。
4. 应用代码访问引擎的边界：`apps/kimi-code/src` 中直接 import `@moonshot-ai/agent-core-v2` 的文件共 4 个 —— `src/cli/v2/run-v2-print.ts`、`src/cli/v2/validate-config.ts`（`apps/kimi-code/DEVELOP.md` 明文豁免）、`src/constant/app.ts`（仅 deep path 重导出一个环境变量常量 `KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV`）、`src/utils/plugin-marketplace.ts`（deep path `app/plugin/marketplace`，运行时函数 + 类型）。后两个是**未被文档豁免的既成事实**，须在第 5 章如实记录。其余一律经 `@moonshot-ai/kimi-code-sdk`；`apps/kimi-code/src` 中没有任何文件 import `@moonshot-ai/klient`。
5. `bun run dev:cli` 在当前工具链下**不可用**（Bun 1.4.2 不解析 `package.json#imports` 通配符）；仓库提供的可用路径是 `bun run dev:local`（`scripts/run-local.sh`，先 tsdown 打包再跑 `dist/main.mjs`）。
6. 测试由根 `vitest.config.ts` 的 projects 决定，`packages/minidb` 被显式排除并有独立 CI 作业；`packages/pi-tui` 走 `node:test`。
7. `packages/kosong` 为冻结的旧 LLM 内核，`agent-core-v2` 不再 import 它，边界由 `packages/agent-core-v2/scripts/check-import-boundaries.mjs` 强制。
8. 结构性不清晰项（至少覆盖）：`packages/node-sdk/src/sdk-rpc-client-v2.ts` 的 MVP/逃生口、引擎内 `human/llm` 与 `llm-adapter` 两套 LLM 代码、`apps/kimi-web` 游离于工作区之外、`flake.nix` 的 `workspacePaths` 需手工同步、`apps/kimi-code/dist-web` 是外部同步的预构建产物、根 `AGENTS.md` 与 `DEVELOP.md` 的并存关系。

## 7. 风险与依赖

- **R-1 体量风险**：仓库 11G（含 `node_modules`），引擎 2968 个 TS 文件；不可能逐文件读完。缓解：以目录职责 + 关键文件 + 强制边界脚本为骨架，规模数字用命令复现。
- **R-2 文档漂移风险**：`DEVELOP.md` 声称的路径/脚本可能与代码现状不符（例如 `dev:cli` 已在文档中自我声明断裂）。缓解：以代码与配置为准，冲突处在第 5 章单列。
- **R-3 覆盖均匀性风险**：小包（如 `packages/i18n-shared` 409 行）容易被一句话带过。缓解：R2 的成员集合校验。
