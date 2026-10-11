# Tasks — 分章产出 `architecture.md`

设计见 `design.md`，需求见 `requirements.md`。每个任务都是**可独立验收**的一章或一次校验；T9–T11 是收尾门禁，任一失败则该章退回重做。

## 约定

- 目标文件：`specs/domino-hawkgirl-dazzler/architecture.md`（唯一交付物）。
- 允许写入的路径：仅 `specs/domino-hawkgirl-dazzler/`。
- 每个任务完成后，把"证据命令 → 输出"追加到该章的脚注块，供 T9/T10 复核。
- 未确认项不得留在正文：进附录 B（T8）。

---

## T1 — 第 1 章：整体结构与技术栈

**产出**：`architecture.md` 第 1 章（产品形态、技术栈表、依赖来源、体量事实表、工作区成员）。

**验收标准**（全部可执行）：
1. 技术栈表覆盖 6 个维度：语言/运行时、包管理与构建、Web 前端、原生、质量工具、发布产物。
2. 体量事实表与 `design.md` §2 第 1 章表格**逐格一致**（26 行 + `tools/review`/`docs` 行）。
3. 工作区成员计数为 26，且明写 `apps/kimi-web` 不在根工作区、`flake.nix` 有第二份 `workspacePaths` 清单。
4. 依赖来源四件套（`catalog` / `overrides` / `patchedDependencies` / `trustedDependencies`）各给出至少 1 个具体条目与所在文件。
5. 命令 `node -e "…readdirSync('packages')…"`（附录 A-1）输出 26，与正文一致。

---

## T2 — 第 2 章：引擎（`packages/agent-core-v2`）

**产出**：第 2.1 节，按 `_base` / `app` / `agent` / `session` / `features` / `human` / `llm-adapter` / `tool` / `wire` / `state` / `workspace` / `persistence` / `runtime` / `program` / `mcpCore` / `os` / `debug` 逐目录说明职责。

**验收标准**：
1. 每个目录一条：`目录 | 职责 | 代表性文件（真实路径）`。
2. 三处计数与命令一致：`features/` 26 个域、`agent/` 49 个子模块、`app/` 38 个子模块。
3. 明写 `index.ts` 是公开导出面（`export * from '#/…'` 风格），并给出 3 个被导出的符号名。
4. 明写 `features/*` 的域内结构模式（`xxxFeature.ts` + `xxxService.ts` + `tools/`），并用至少 2 个域（`plan`、`swarm` 或 `tower`）举例。
5. 指出 `human/AGENTS.md` 与 `human/llm/AGENTS.md` 是该目录的局部规则入口（只引用，不复述内容）。

---

## T3 — 第 2 章：服务与 SDK 面

**产出**：第 2.2 节，覆盖 `kap-server`、`klient`、`node-sdk`、`acp-server`、`remote-control`、`telemetry`、`transcript`。

**验收标准**：
1. `kap-server`：说明 `start.ts` 的 Fastify 引导、`routes/` 40 个模块、`protocol/` 契约目录、`transport/ws`，并给出 `/api/v1`、`/api/v1/ws`、`/api/v1/debug` 三个面。
2. `klient`：说明 `contract/`（`global`/`session`/`agent` 三类）+ `core/validation.ts`（zod 双向校验）+ 两种传输（`memory` / `ipc`，后者是 unix socket + NDJSON 帧）。
3. `node-sdk`：说明它是 `apps/kimi-code` 与 `apps/vscode` 的唯一引擎入口，给出 `createKimiHarness` 与 `SDKRpcClientV2` 两个符号及其文件。
4. `acp-server`：说明它是 ACP 宿主，`src/index.ts` 导出的 `AcpServer` / `runAcpServer` 与 `kimi acp` 的对应关系。
5. `transcript`：说明 L1 store / L2 ops / L3 granularity / L4 view 四层，并给出 `src/index.ts` 中对应的导出分组。
6. `remote-control` 与 `telemetry` 各至少一条职责 + 真实路径。

---

## T4 — 第 2 章：支撑包

**产出**：第 2.3 节，覆盖 `kaos`、`minidb`、`pi-tui`、`kosong`、`oauth`、`i18n`、`i18n-shared`、`tree-sitter-bash`、`migration-legacy`、`kimi-native-tools`、`kimi-agent`。

**验收标准**：
1. `kaos`：三个执行环境后端（local / ssh / login-shell）与对应文件。
2. `minidb`：说明内存 KV + WAL/快照 + 二级索引 + 全文索引 + cluster 子目录，并引用 `packages/minidb/DEVELOP.md`。
3. `pi-tui`：说明它是 TUI 框架（差分渲染）、测试用 `node:test`（与 vitest 分离）、引用 `packages/pi-tui/DEVELOP.md`。
4. `kosong`：明写"冻结、引擎不再 import、边界由脚本拒绝、wire 规则两份拷贝靠 parity 测试维持"，并给出 `check-import-boundaries.mjs` 与 `cache-field-parity.test.ts` 路径。
5. `kimi-native-tools`：列出至少 8 个 Rust 模块名（bash/grep/glob/read/write/edit/fetch_url/llm_stream…）与 napi 六目标矩阵所在文件。
6. `kimi-agent`：明写它是实验性 Rust 引擎（napi-rs），`cli` feature 控制二进制目标。
7. `i18n` 与 `i18n-shared` 的关系写清：Rust `translation.rs` ↔ 纯 JS `core.ts` 镜像，`web.ts` 为浏览器工厂。
8. `migration-legacy` 的迁移方向写明（`~/.kimi/` → `~/.kimi-code/`），并给出 `run-migration.ts` 路径。

---

## T5 — 第 2 章：应用层

**产出**：第 2.4 节，覆盖 `apps/kimi-code`（展开）、`apps/vscode`、`apps/kimi-inspect`、`apps/vis/{server,web}`、`apps/kimi-web`、`docs`。

**验收标准**：
1. `apps/kimi-code` 展开到 `src/` 一级子目录（`cli`/`tui`/`i18n`/`native`/`migration`/`feedback`/`utils`/`constant`/`generated`），每个一条职责。
2. `tui/` 展开到 `controllers` / `components` / `commands` / `panes` / `reverse-rpc` / `theme` / `banner`，并引用 `apps/kimi-code/DEVELOP.md`（不复述其规范条目）。
3. slash 命令数写为 46，并给出 `src/tui/commands/registry.ts` 与产生该数字的命令。
4. `cli/sub/` 列出全部子命令文件名（13 个），与 `DEVELOP.md` 声称的子命令清单交叉标注差异（若有）。
5. `apps/kimi-web` 明写"Vue 3 + Vite、工作区外、自带 bun.lock、`apps/kimi-code/dist-web` 是它的预构建产物/外部同步"。
6. `apps/vscode` 写明 React 19 webview + `webview-ui/` + `vitest.projects.ts` 被根配置引用。
7. `apps/kimi-inspect` 写明它读 `/api/v1/debug` 的 RPC 面，`src/panels.ts` 是策展面板入口。
8. `apps/vis` 写明 server/web 两部分与 `kimi vis` / `#/generated/vis-web-asset` 的关系。

---

## T6 — 第 2 章：非工作区目录

**产出**：第 2.5 节，覆盖 `scripts/`、`tools/review`、`plugins/`、`build/`、`specs/`、`reports/`、`参考目录/`、`patches/`、`.agents/skills`、`.changeset/`、`dist-native/`。

**验收标准**：
1. `scripts/` 逐个列出 11 个脚本 + 每个对应的根 npm script 名（无对应脚本的显式标注）。
2. `tools/review` 列出 9 个 check 文件名、4 份 baseline 文件名，并给出构建/运行命令（`zig build`、`--list`、`--check=`、`--json`）。
3. `plugins/` 说明 `marketplace.json` + `official/kimi-datasource` + `official/kimi-webbridge`。
4. `reports/` 与 `参考目录/` 明写其非权威地位（现场痕迹，非事实来源）。
5. `.agents/skills` 列出 8 个 skill 目录名。
6. 每个目录给出至少一个真实路径。

---

## T7 — 第 3 章：入口、核心流程与调用关系

**产出**：第 3 章。

**验收标准**：
1. 入口清单 ≥ 6 条，每条给出 `文件路径` + 触发方式（`bin`、子命令、工作流、扩展激活）。
2. TUI 主链路写成一条完整箭头链，覆盖 `main.ts` → `validateOptions` → 更新预检 → `run-shell.ts` → `createKimiHarness` → `KimiTUI` → `controllers/*` → SDK 事件流；每个箭头至少一端带文件路径。
3. 引擎链路写明三层 Scope（App/Session/Agent）来自 `src/app/scopes.ts`，`bootstrap()` 在 `src/app/bootstrap/bootstrap.ts`，主循环在 `agent/loop/loopService.ts` + `agent/loop/machine/engine.ts`。
4. 服务链路写明 `kap-server/src/start.ts` → `bootstrap` + `createInstanceRegistry` → `routes/registerApiV1Routes.ts`，并列出消费者（VS Code / kimi-web / kimi-inspect）。
5. 客户端链路写明 `SDKRpcClientV2` 用 **klient + memory 传输**在进程内启动引擎（不是网络调用），并给出文件与行数。
6. 给出"禁止边"清单，每条附强制脚本：app→engine（`cli/v2` 例外）、engine→kosong（`check-import-boundaries.mjs`）、deep import（`check-deep-imports.mjs`）。
7. 至少 4 处关键实现细节带行号级锚点（例如 `sdk-rpc-client-v2.ts:611` 的 `engineAccessor` getter）。

---

## T8 — 第 4 章 + 附录 A/B

**产出**：第 4 章（构建/运行/测试/CI）与附录 A（复现命令集）、附录 B（未展开/存疑）。

**验收标准**：
1. 运行章节明确标注 `bun run dev:cli` **不可用**及其原因（Bun 不解析 `#/*` imports 通配符）与替代命令 `bun run dev:local`。
2. 测试章节列出根 `vitest.config.ts` 的 projects 全集，并单列 `packages/minidb`（被排除）与 `packages/pi-tui`（`node:test`）。
3. CI 章节的作业名集合 == `grep -E '^  [a-z-]+:' .github/workflows/ci.yml` 的结果集合（含 `test-windows` 的 `if: false` 状态）。
4. 工作区外工作流清单 == `.github/workflows/` 目录内容减去 `ci.yml`（共 10 个）。
5. Makefile 目标与根脚本的映射表逐行给出。
6. 附录 A 的每条命令都能**原样粘贴执行且只读**（不含 `build`/`test`/`install`）；给出命令与其期望输出。
7. 附录 B 至少收录：需要跑构建才能确认的产物内容、只从文档读到未从代码验证的结论。

---

## T9 — 校验 R1（零改动）与 R3（路径真实）

**验收标准**：
1. `git status --porcelain` 中，除 `?? AGENTS.md`（改动前既存）与 `?? specs/domino-hawkgirl-dazzler/` 外，无任何条目。
2. `design.md` §4 的 C2 脚本对 `architecture.md` 运行后**无 `MISSING` 输出**；若某路径确实不存在，必须从正文删除或修正为真实路径后重跑。
3. 校验脚本本身被记录在附录 A 中。

---

## T10 — 校验 R2（成员覆盖）与 R4（数字可复现）

**验收标准**：
1. C3 脚本对 26 个工作区成员逐一检查，**无 `UNCOVERED` 输出**。
2. 抽 10 个正文数字重跑其命令，结果与正文一致（不一致则改正文，不改命令）。
3. 正文中每个计数都能在附录 A 找到对应命令编号；找不到的计数视为未完成。

---

## T11 — 终审：章节完整、规则不重复、结论不下沉

**验收标准**：
1. `grep -c '^## '` ≥ 7（5 个正文章 + 附录 A + 附录 B）。
2. 文档中不出现 `DEVELOP.md` 规范条目的**逐字复制**：抽查 `DEVELOP.md` 的 10 条 "General Coding Rules"，逐条确认本文档未复述其内容（只允许出现引用路径）。
3. 抽查 5 条结论，每条都能在其所在段落内找到路径锚点或命令锚点；有 1 条缺失即退回该章。
4. 附录 B 非空，且正文中不含"可能/大概/应该"类的未证实断言（抽查 10 处）。
5. 最终向用户汇报时，同时给出：文档路径、章节清单、本次调研得出的 Top 5 值得注意项、以及 C1–C4 的实际输出。

---

## 依赖顺序

```
T1 ─┬─ T2 ─ T3 ─ T4 ─ T5 ─ T6 ─┐
    └─────────────────────────┴─ T7 ─ T8 ─ T9 ─ T10 ─ T11
```

T2–T6 之间无依赖，可并行；T7 依赖 T2–T6 的路径清单；T9–T11 必须在 T1–T8 全部完成后执行。
