# Design — 交付物形态、章节结构与证据规则

需求见 `requirements.md`（Q1–Q5、R1–R7、§6 硬事实）。本文件给出**最终文档长什么样、每一章必须承载哪些事实、以及这些事实如何被机器校验**。

## 0. 一句话设计

**一份文档 + 两条校验**：`specs/domino-hawkgirl-dazzler/architecture.md` 是唯一交付物；R1（零改动）与 R3/R4（路径真实、数字可复现）各由一条命令校验，不依赖人工审读。

## 1. 交付物

| 项 | 值 |
| --- | --- |
| 主交付物 | `specs/domino-hawkgirl-dazzler/architecture.md` |
| 语言 | 中文叙述，标识符/路径/命令保持原样 |
| 章节数 | 5 个正文章 + 2 个附录 |
| 目标篇幅 | 不设上限；受 R2 约束（26 个成员同等深度），预计 900–1400 行 |
| 不进正文 | 未从代码确认的项 → 附录 B |

## 2. 章节结构（每一章对应一个用户问题）

### 第 1 章 整体结构与技术栈 → Q1

必须包含：

1. **产品是什么**：一段话 + 可执行形态列表（CLI/TUI、headless `-p`、本地 server、ACP、VS Code、Web、inspector、vis）。
2. **技术栈表**：语言与运行时（TS 6.0.2 strict、Bun 1.4.2 作为包管理器与打包器、Node 24.15.0 仅 Nix 路径需要）、Web 侧（Vue 3 / React 19 + Tailwind 4）、原生（Rust + napi-rs）、构建器（tsdown、vite、cargo、zig）、质量工具（oxlint/oxfmt/vitest/changesets/sherif/publint/attw）。
3. **依赖来源**：`bun.lock`、`package.json` 的 `catalog`（zod/pathe/smol-toml/jimp/yazl/ulid/ws/tsx）、`overrides` 安全下限、`patchedDependencies`（`patches/ssh2@1.17.0.patch`）、`trustedDependencies`。
4. **体量事实表**（下列数字均由第 4 节的命令产生，必须原样带命令）：

| workspace | src 文件 | src 行 | test 文件 | test 行 |
| --- | --- | --- | --- | --- |
| packages/agent-core-v2 | 1258 | 171062 | 407 | 175799 |
| apps/kimi-code | 381 | 83309 | 277 | 88446 |
| packages/kap-server | 168 | 31824 | 75 | 39331 |
| apps/kimi-web | 168 | 29720 | 35 | 11355 |
| packages/minidb | 61 | 20357 | 45 | 17870 |
| packages/pi-tui | 43 | 19998 | 38 | 19535 |
| apps/kimi-inspect | 69 | 13844 | 1 | 41 |
| packages/node-sdk | 48 | 11836 | 28 | 10128 |
| packages/kosong | 41 | 11298 | 51 | 28068 |
| apps/vis/web | 52 | 9119 | 7 | 788 |
| packages/oauth | 29 | 7601 | 21 | 8671 |
| apps/vscode | 33 | 7461 | 22 | 8475 |
| packages/klient | 51 | 6031 | 13 | 5016 |
| packages/acp-server | 26 | 5668 | 14 | 3929 |
| packages/tree-sitter-bash | 7 | 5295 | 6 | 2387 |
| packages/migration-legacy | 32 | 4160 | 28 | 4534 |
| packages/transcript | 25 | 4070 | 2 | 4661 |
| apps/vis/server | 28 | 3924 | 18 | 3503 |
| packages/kaos | 12 | 3265 | 19 | 6559 |
| packages/i18n | 4 | 1777 | 2 | 367 |
| packages/remote-control | 4 | 1503 | 1 | 1019 |
| packages/telemetry | 10 | 1331 | 2 | 1684 |
| packages/i18n-shared | 5 | 401 | 0 | 0 |
| packages/kimi-native-tools | Rust 35 文件 / 19387 行 | — | 1 | 230 |
| packages/kimi-agent | Rust 22 文件 / 8661 行 | — | 0 | 0 |
| tools/review | Zig 22 文件 / 5497 行 | — | — | — |
| docs | VitePress，无 src | — | — | — |

5. **工作区成员**：26 个（含 `apps/vis/server`、`apps/vis/web`、`docs`），并明确 `apps/kimi-web` **不在**根工作区内（自带 `bun.lock`、独立安装），以及 `flake.nix` 的 `workspacePaths` 是手工同步的第二份清单。

### 第 2 章 目录与模块职责 → Q2

分三段，**每个 workspace 成员一段，结构统一**（`包名@版本 | 一句话职责 | 关键目录 | 依赖/被依赖`）：

- **2.1 引擎**：`agent-core-v2` 按内部目录展开 —— `_base`（DI/Scope/日志/工具）、`app`（38 个子模块：bootstrap、config、auth、plugin、flag、scopes）、`agent`（49 个子模块：loop、toolExecutor、permission*、fullCompaction、microCompaction、task、team、undo…）、`session`（20 个：agentLifecycle、subagent、usage、tokenCounting…）、`features`（26 个域：plan、swarm、tower、goal、skill、spec、cron、lsp、astron…）、`human`（会话/LLM 的宿主侧实现）、`llm-adapter`（contract/model/protocol/provider）、`tool`、`wire`、`state`、`workspace`、`persistence`、`runtime`、`program`、`mcpCore`、`os`、`debug`。
- **2.2 服务与 SDK 面**：`kap-server`（40 个 route 文件 + `protocol/` 40+ 契约 + `transport/ws`）、`klient`（contract/core/transports）、`node-sdk`、`acp-server`、`remote-control`、`telemetry`、`transcript`。
- **2.3 支撑包**：`kaos`、`minidb`、`pi-tui`、`kosong`、`oauth`、`i18n`、`i18n-shared`、`tree-sitter-bash`、`migration-legacy`、`kimi-native-tools`、`kimi-agent`。
- **2.4 应用**：`kimi-code`（cli/tui/i18n/native/migration/feedback/utils/constant/generated）、`vscode`、`kimi-inspect`、`vis/{server,web}`、`kimi-web`、`docs`。
- **2.5 非工作区目录**：`scripts/`（11 个检查/扫描脚本）、`tools/review`（Zig 结构审查，9 个 check）、`plugins/`（marketplace.json + official 两插件）、`build/`（raw-text loader）、`specs/`、`reports/`（gitignored）、`参考目录/`、`patches/`、`.agents/skills`（8 个 skill）。

每个成员必须给出**至少一个真实路径**作为职责锚点；只有名字没有路径的条目视为未完成。

### 第 3 章 入口、核心流程与调用关系 → Q3

1. **入口清单**：`apps/kimi-code/src/main.ts`（`bin: kimi` → `dist/main.mjs`）、`apps/kimi-code/src/cli/commands.ts`（Commander 定义）、`packages/kap-server/src/start.ts`（Fastify）、`packages/acp-server/src/start.ts`、`apps/vis/server/src/start.ts`、`apps/vscode/src/extension.ts`。
2. **主链路（TUI）**：`main.ts` → `validateOptions` → 更新预检 → `run-shell.ts` → `createKimiHarness()`（node-sdk）→ `KimiTUI`（`src/tui/kimi-tui.ts`）→ `controllers/*` → SDK 事件流。
3. **主链路（引擎）**：`bootstrap()` → `createAppScope()`（App/Session/Agent 三层 Scope，`src/app/scopes.ts`）→ `IAgentLoopService`（`agent/loop/loopService.ts`）→ turn machine（`agent/loop/machine/engine.ts`）→ `toolExecutor` → `features/*`。
4. **服务链路**：`kap-server/src/start.ts` → `bootstrap` + `createInstanceRegistry` → `routes/registerApiV1Routes.ts`（40 个 route 模块）+ `/api/v1/ws`；消费者为 VS Code、`kimi-web`、`kimi-inspect`（经 `/api/v1/debug/*`）。
5. **客户端链路**：`node-sdk` 的 `KimiHarness` 与 `SDKRpcClientBase`；`SDKRpcClientV2`（`src/sdk-rpc-client-v2.ts`）经 **klient 门面 + memory 传输**在进程内启动引擎，而非走网络。
6. **调用关系图**：用文本箭头图给出四条边界（app→SDK→klient→engine、engine→kap-server、engine→acp-server、engine→node-sdk），并标注"禁止边"及其强制脚本。

### 第 4 章 构建、运行、测试 → Q4

必须按"**仓库里真实存在且当前可用**"来写，并明确标注不可用项：

- 前置：Bun ≥ 1.4（本机 1.4.2）、Node 24.21.0（仅 Nix 路径需要）、Rust（原生工具）。
- 安装：`bun install`（`bunfig.toml` 固定 `linker = "hoisted"`）。
- **运行**：`bun run dev:local` / `dev:local:watch`（`scripts/run-local.sh`：指纹比较 → tsdown 打包 → 跑 `apps/kimi-code/dist/main.mjs`）；`bun run dev:server`；`bun run vis`；`cd apps/kimi-web && bun run dev`。**`bun run dev:cli` 在当前 Bun 下不可用**（`#/*` imports 通配符不解析），须写明症状与替代路径。
- **构建**：`bun run build` / `build:packages` / `apps/kimi-code` 的 `tsdown` + `prebuild`（`build-vis-asset.mjs`）+ `copy-native-assets` + `check-web-assets`；原生：`build:native:js` → `build:native:bun[:release]` → `package:native` → `produce:native:manifest`（脚本 `apps/kimi-code/scripts/native/01-bundle.mjs`、`build-bun.mjs`、`bun-entry.ts`）。
- **测试**：`bun run test`（根 vitest projects：`packages/*` 除 `minidb`、`apps/kimi-code`、`apps/kimi-inspect`、`apps/vis/server`、`apps/vis/web`、`apps/vscode`）；`test:minidb`（单独，因 ~40s）；`pi-tui` 走 `node:test`；`kimi-code` 的 `test` 会先 `build:packages`；e2e 需 `KIMI_E2E=1`；`cargo test` 覆盖 Rust。
- **质量门**：`typecheck`（tsc/tsgo）、`lint`（oxlint --type-aware）、`sherif`、`check:deep-imports`/`check:boundaries`、`check-no-comments`（基线账本）、locale 三项检查、`check:catalog-versions`、`tools/review` 的 9 个 check 与 4 份 baseline。
- **CI**：`.github/workflows/ci.yml` 的作业表（build / test ×5 分片 / test-pi-tui / test-minidb / test-kimi-web / test-windows（`if: false` 停放）/ lint / review / typecheck），以及工作区外的工作流（`_native-build.yml` 六目标矩阵、`release-native.yml`、`nix-build.yml`、`codeql.yml`、`docs-deploy.yml`、`pkg-pr-new.yml`、`pr-title-checker.yml`、`vscode-publish.yml`、`manual-native-bundle.yml`）。
- **Makefile**：`make prepare/build/typecheck/lint/test/rust-build/rust-check/rust-test` 与对应根脚本的映射。

### 第 5 章 值得注意的部分 → Q5

只写**现象 + 证据 + 影响面**，不给方案。至少覆盖（每条都要有路径与行数/计数）：

1. **迁移中的 v2 客户端**：`packages/node-sdk/src/sdk-rpc-client-v2.ts`（2928 行，`engineAccessor` 出现 47 次），文件头自述"migrated so far"清单；逃生口绕过 klient 契约与 zod 校验。影响面：SDK 公开面与引擎内部耦合。
2. **两套 LLM 代码并存**：`agent-core-v2/src/human/llm/**` 与 `src/llm-adapter/**`，外加冻结的 `packages/kosong`（仅 `node-sdk`/`oauth` 消费），wire 规则存在两份拷贝，靠 `packages/kosong/test/cache-field-parity.test.ts` 维持一致。
3. **超大单文件**：`kimi-tui.ts` 3016 行、`loopService.ts` 2196 行、`apps/kimi-code/src/i18n/locales/{en,zh}.ts` 2797/2713 行、`packages/pi-tui/src/components/editor.ts` 2743 行、`apps/kimi-code/src/tui/components/messages/tool-call.ts` 2692 行、`packages/tree-sitter-bash/src/parser.ts` 3988 行。
4. **文档与代码的偏差**：`apps/kimi-code/src` 直接 import 引擎的 4 个文件（其中 2 个未被 `DEVELOP.md` 豁免）；`dev:cli` 在 `DEVELOP.md` 中已自述断裂但根 `README.md` 仍把它列为开发入口。
5. **工作区成员的双份清单**：根 `package.json` vs `flake.nix` 的 `workspacePaths`，`scripts/check-nix-workspace.mjs` 只校验 `@moonshot-ai/kimi-code` 的闭包。
6. **游离的构建产物与包**：`apps/kimi-code/dist-web`（4 个条目，外部仓库同步，"replace never overlay" 约定）；`apps/kimi-web` 排除在根工作区外却出现在 `typecheck` 脚本里；`apps/kimi-code/src/generated/vis-web-asset.ts` 由 `prebuild` 生成。
7. **注释禁令的例外账本**：`scripts/no-comments-baseline.txt` 与 `reports/`、`参考目录/`、根 `AGENTS.md`（未跟踪）等现场痕迹。
8. **218 个未消费的 changeset**：`.changeset/` 文件数，与"fork 跟随 upstream 版本、release 作业中 changesets/action 已注释"的矛盾。
9. **测试集中度**：单文件最大测试 9146 行（`apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`），`test/` 与 `src/` 行数接近 1:1，阅读成本主要在测试侧。

### 附录

- **附录 A 复现命令集**：第 1 章表格、各计数的生成命令，逐条可粘贴。
- **附录 B 未展开 / 存疑**：只读过文档未读代码的结论、无法在只读模式下验证的项（如需要跑构建才能确认的产物内容）。

## 3. 证据规则（写作时的硬约束）

| 规则 | 具体做法 |
| --- | --- |
| 路径锚定 | 每条结论后跟 `` `path/to/file.ts` ``；不写"某个 controller"这类无锚点描述 |
| 数字带命令 | 每个计数紧跟其命令（`find … | wc -l`），或指向附录 A 的编号 |
| 文档 vs 代码 | 引用 `DEVELOP.md`/`README.md` 的结论时前缀"文档声称："；代码确认后改为直述 |
| 不抄全局规则 | 只写"见 `DEVELOP.md` → 章节名"，不复述条目内容（R7） |
| 不确定就下沉 | 无法核实的判断一律进附录 B，不留在正文 |

## 4. 校验方法（可执行）

```bash
# C1 零改动（R1）
cd /home/administrator/kimi/kimi-code && git status --porcelain | grep -v '^?? AGENTS.md$' | grep -v '^?? specs/domino-hawkgirl-dazzler/' | wc -l   # 期望 0

# C2 路径真实（R3）：抽取反引号里的仓库相对路径并逐个 test -e
cd /home/administrator/kimi/kimi-code && grep -oE '`(packages|apps|scripts|tools|plugins|build|docs|specs)/[A-Za-z0-9._/@-]+`' specs/domino-hawkgirl-dazzler/architecture.md \
  | tr -d '`' | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING $p"; done   # 期望无输出

# C3 成员覆盖（R2）：26 个成员名全部出现
cd /home/administrator/kimi/kimi-code && node -e "…workspaces 展开…" | while read -r m; do grep -q "$m" specs/domino-hawkgirl-dazzler/architecture.md || echo "UNCOVERED $m"; done   # 期望无输出

# C4 数字可复现（R4）：重跑附录 A 的命令，与正文数字逐一比对

# C5 章节完整：5 个正文章标题 + 2 个附录存在
grep -c '^## ' specs/domino-hawkgirl-dazzler/architecture.md
```

## 5. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 只输出到对话、不落盘 | 用户已明确选择"只写入 spec 目录"；且 900+ 行内容不适合留在会话里，无法校验 R2/R3 |
| 把说明写进仓库 `ARCHITECTURE.zh-CN.md` 并纳入 VitePress 导航 | 超出用户选择（会改动仓库其他文件），且需要跑 `docs` 构建才能验证，违反 R6 |
| 按"文件树逐文件注释"的方式组织 | 3821 个源文件无法逐一处理，且会把文档变成目录镜像，丢失"职责/调用关系"这两个真正被问到的维度 |
| 以 `DEVELOP.md` 的叙述为骨架直接翻译 | 违反 R3/R5：文档已有与代码不符处（`dev:cli`、引擎 import 边界），直接翻译会把偏差固化 |
| 用 `tools/review` 或 lint 输出作为结构依据 | 这些工具回答的是"门是否接线"，不是"模块职责"；且 `tools/review` 需要 `zig build`（写操作） |
