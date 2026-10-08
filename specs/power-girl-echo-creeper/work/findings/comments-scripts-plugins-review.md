# Pass 2 注释审计 — scripts/**、plugins/**、tools/review/**、build/**

范围：`scripts/**`、`plugins/**`、`tools/review/**`、`build/**` 下全部源文件的注释（.mjs/.cjs/.js/.zig，含 plugins 的 SKILL.md / plugin.json / marketplace.json）。
方法：逐文件读注释，对每条可验证断言（命令、路径、数量、默认值、版本、符号名、控制流）回到代码与仓库实际状态核对；对可疑项实跑只读命令验证。
已排除（按任务硬性排除项）：`node:` 内置导入、`@types/node`、原生插件加载器的 `require()`/`createRequire`、`apps/kimi-code/scripts/postinstall/`、`packages/pi-tui` 的 node:test 套件、`apps/kimi-code/src/cli/sub/plugin-run-node.ts`、`specs/`、`dist-web/`、`参考目录/`、`**/dist/`。

已读文件（无发现的文件也列出）：
`scripts/check-locale-keys.mjs`、`scripts/check-locale-placeholders.cjs`、`scripts/check-nix-workspace.mjs`、`scripts/check-no-comments.mjs`、`scripts/check-service-naming.mjs`、`scripts/check-t-call-coverage.mjs`、`scripts/generate-locale-json.cjs`、`scripts/scan-hardcoded.mjs`、`scripts/scan-hardcoded-v2.mjs`、`build/raw-text-loader.mjs`、`build/raw-text-plugin.mjs`、`build/register-raw-text-loader.mjs`、`tools/review/check-catalog-versions.mjs`、`tools/review/build.zig`、`tools/review/src/{main,check,checks,fsutil,lexer,pkgjson,proc,report,ts_scan,walk,workflow,probe_main}.zig`、`tools/review/src/checks/{ci_coverage,dangling_refs,gate_wiring,orphan_exports,scripts_wiring,silent_catch,stale_artifacts,upstream_drift,workflow_triggers}.zig`、`plugins/marketplace.json`、`plugins/official/kimi-datasource/{kimi.plugin.json,SKILL.md,bin/kimi-datasource.mjs}`、`plugins/official/kimi-webbridge/{kimi.plugin.json,skills/kimi-webbridge/SKILL.md,skills/kimi-webbridge/references/operations.md}`。

已核实为**正确**、故不报告的断言（避免误报，列出以便复核）：
- `plugins/official/kimi-datasource/SKILL.md:5` 的工具名 `mcp__plugin-kimi-datasource_data__…`：`packages/agent-core-v2/src/app/plugin/manager.ts:709` 生成 `plugin-<id>:<server>`，`packages/agent-core-v2/src/mcpCore/tool-naming.ts:6-11` 的 `sanitizeMcpNamePart` 把 `:` 换成 `_`，结果一致。
- `plugins/official/kimi-datasource/SKILL.md:23` 的「25 个外部数据源」：与 `plugins/official/kimi-datasource/bin/kimi-datasource.mjs:62-88` 的 enum 项数一致（25）。
- `plugins/official/kimi-datasource/SKILL.md:152` 的 `${KIMI_SKILL_DIR}`：与 `packages/agent-core-v2/src/features/skill/catalog/registry.ts:168` 的替换逻辑一致。
- `plugins/official/kimi-datasource/bin/kimi-datasource.mjs:1` 的 `#!/usr/bin/env node` 与 `kimi.plugin.json` 的 `"command": "node"`：`packages/agent-core-v2/src/app/plugin/manager.ts:735-748` 明确把 `node` 重写到 `process.execPath` + `__plugin_run_node`，属刻意设计，不算 Node 时代残留。
- `tools/review/check-catalog-versions.mjs:19-21` 称 `apps/kimi-web` 在根 workspace 之外、用自己的 lockfile：`package.json` 的 `workspaces.packages` 含 `"!apps/kimi-web"`，且 `apps/kimi-web/bun.lock` 存在，断言成立。
- `tools/review/src/checks/gate_wiring.zig:210-212` 称「Scripts are one per line in this repository」：抽查根与 5 个包的 `package.json`，`scripts` 块内无跨行值，断言成立。

---

## 发现

- `scripts/check-locale-keys.mjs:7` — 类别 1 · 中 — 注释写 `Usage: node scripts/check-locale-keys.mjs`，实际调用是 `bun scripts/check-locale-keys.mjs`（依据：`package.json:50`、`.github/workflows/ci.yml:182`）。
- `scripts/check-t-call-coverage.mjs:5` — 类别 1 · 中 — 注释写 `Usage: node scripts/check-t-call-coverage.mjs`，实际调用是 `bun scripts/check-t-call-coverage.mjs`（依据：`package.json:51`、`.github/workflows/ci.yml:184`）。
- `scripts/check-locale-placeholders.cjs:1` — 类别 1 · 中 — shebang 是 `#!/usr/bin/env node`，但该脚本在 CI 与本地都由 Bun 执行（依据：`.github/workflows/ci.yml:183`）。
- `scripts/check-locale-placeholders.cjs:10` — 类别 1 · 低 — 注释写 `Usage: node scripts/check-locale-placeholders.cjs`，实际调用是 `bun scripts/check-locale-placeholders.cjs`（依据：`.github/workflows/ci.yml:183`）。
- `scripts/scan-hardcoded-v2.mjs:13` — 类别 1 · 低 — 用法注释写 `node scripts/scan-hardcoded-v2.mjs`，实际调用是 `bun scripts/scan-hardcoded-v2.mjs`（依据：`package.json:52`）。
- `scripts/check-locale-placeholders.cjs:55-56` — 类别 1 · 中 — 注释称 `require()` 能加载 TS 文件是「thanks to tsx registration」，但该脚本没有任何 tsx 注册（文件内唯一 import 是 `scripts/check-locale-placeholders.cjs:15` 的 `node:path`），CI 也不设 `NODE_OPTIONS`；实际是 Bun 原生转译 TS（依据：`.github/workflows/ci.yml:183`）。
- `build/register-raw-text-loader.mjs:4-5` — 类别 1 · 中 — 注释称「Pass to Node via `--import` (alongside tsx)」，实际全部调用点都是 `bun --import`，没有 Node、没有 tsx（依据：`packages/klient/package.json:38`、`apps/kimi-code/package.json:66`、`apps/kimi-code/scripts/dev.mjs:53`、`apps/kimi-code/scripts/dev-server-restart.mjs:31`）。
- `scripts/check-locale-keys.mjs:85` — 类别 2 · 低 — 注释称「Fallback: use require via createRequire for CommonJS TS files」，但该 catch 块是空的，既没有 `createRequire` 也没有 `require`（依据：`scripts/check-locale-keys.mjs:84-86`）。
- `scripts/check-locale-keys.mjs:96` — 类别 2 · 低 — 注释称「Try .ts extension explicitly」，但重试导入的是同一个 URL，`scripts/check-locale-keys.mjs:98` 的 `${fileUrl}` 与 `:93` 的 `fileUrl` 完全相同，重试必然以同样方式失败。
- `scripts/check-locale-keys.mjs:115-116` — 类别 2 · 中 — 注释称 kimi-web 分支「Unused now that kimi-web source lives outside this repo」，但 `apps/kimi-web/src/i18n/locales/index.ts` 就在仓库内，且该条目是 `LOCALE_SOURCES` 中唯一 `extract: true` 的（依据：`scripts/check-locale-keys.mjs:52-56`、`:114`），分支必然执行；实跑 `bun scripts/check-locale-keys.mjs` 输出 `✓ kimi-web: 795 keys match`。
- `tools/review/src/checks/scripts_wiring.zig:379` — 类别 2 · 中 — 注释称 `--filter './packages/*'` 位于 `bun` 与 `run` **之间**，实际仓库写法是 `bun run --filter '…' build`，`--filter` 在 `run` 之后（依据：`package.json:29`、`package.json:30`、`package.json:39`）；同文件 `tools/review/src/checks/scripts_wiring.zig:405-408` 的注释也写作「flags between `run` and the name」。
- `tools/review/src/checks/dangling_refs.zig:19` — 类别 2 · 中 — 文件头注释称收集「every string in a constant whose name mentions `TOOL`」，实际只认以 `TOOLS` / `TOOL_NAMES` 结尾的常量（依据：`tools/review/src/checks/dangling_refs.zig:167-168`）；同文件 `:151-153` 的注释明确说更宽的「mentions TOOL」规则已被否决，两处自相矛盾。
- `tools/review/src/checks/workflow_triggers.zig:20-21` — 类别 2 · 中 — 注释称「a workflow with no `on: pull_request:` is skipped entirely」，实际这类 workflow 的 job 会被报成 error（依据：`tools/review/src/checks/workflow_triggers.zig:81-98`）；同文件 `:14-17` 的注释也把 push-only job 描述为要抓的目标，两处自相矛盾。
- `tools/review/src/workflow.zig:593-594` — 类别 2 · 低 — 注释称「Every node carries the file line it was written on」，但 `Node` 是 `union(enum) { scalar, map, seq }`，没有行号字段（依据：`tools/review/src/workflow.zig:14-17`）；行号只存在于 `Walk` 自己的 `line` 字段（`tools/review/src/workflow.zig:601-602`），而 `Walk` 全仓库无人调用（死代码）。
- `scripts/check-service-naming.mjs:6` — 类别 2 · 低 — 注释把 `packages/services/src/<domain>/<domain>.ts` 列为规范根目录，但 `packages/` 下没有 `services` 目录，代码靠 `existsSync` 早退成空操作（依据：`scripts/check-service-naming.mjs:20`、`:40`）。
- `tools/review/src/main.zig:9-11` — 类别 2 · 低 — 注释称「Naming every module here is what makes `zig build test` cover the whole tool」，但 test 块没有列出 `src/probe_main.zig`，该文件不会被 `zig build test` 分析（依据：`tools/review/src/main.zig:12-32` 的 import 清单）。
