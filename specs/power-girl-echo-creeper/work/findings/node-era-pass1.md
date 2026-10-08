# Pass 1 分类 — `require(` / `__dirname` / `__filename` / `createRequire` + 非测试文件的 npm/yarn/pnpm/npx

范围：全仓（排除 `node_modules`、`参考目录`、`specs`、`dist-web`、`**/dist`）中所有 `require(`、`__dirname`、`__filename`、`createRequire` 命中点，以及所有非测试文件里的 npm/yarn/pnpm/npx 命中点。逐条判定「在 Bun 下是否成立」。

方法：`rg` 全量取命中 → 逐条读上下文 → 对可疑项实跑只读命令（`ls`、`git log`、`bun --version`）验证。本机 Bun 版本 1.4.2。

**去重说明**：`packages/pi-tui/**` 的 .md 已由同目录 `pi-tui-docs.md` 覆盖；`scripts/**`、`plugins/**`、`tools/review/**`、`build/**` 的注释已由 `comments-scripts-plugins-review.md` 覆盖。本文件只列**未被这两份覆盖**的发现，重复项在文末「交叉引用」一节列出，不重复计数。

**计数**：14 条（高 0 / 中 12 / 低 2）。另有 2 条候选经核实后撤回，见文末「撤回的候选」。

---

## 发现

- `.github/workflows/vscode-publish.yml:55` — 类别 1 · 中 — 说明：CI 步骤声称从 `.nvmrc` 读取 Node 版本（`node-version-file: .nvmrc`），但仓库根没有 `.nvmrc`（依据：`ls .nvmrc` → `No such file or directory`；`find . -name .nvmrc` 在排除 `node_modules`/`参考目录` 后零命中）。`actions/setup-node@v6` 找不到版本文件即失败；对照同仓 `.github/workflows/ci.yml:19-21` 用的是 `oven-sh/setup-bun@v2` + `bun-version: 1.4.0`。**当前未爆**：该 job 带 `if: github.repository_owner == 'MoonshotAI'`（`:41`），而本仓 origin 是 `7723qqq/kimi-code`（`git remote -v`），条件为假、job 被跳过；一旦 owner 条件成立（同步回上游或改名）即会失败。

- `.github/workflows/vscode-publish.yml:59` — 类别 1 · 中 — 说明：CI 步骤声称用 pnpm 安装依赖（`pnpm install --frozen-lockfile`，前置步骤 `:49-50` 是 `pnpm/action-setup@v6`），但仓库已无 pnpm 工作区：`pnpm-lock.yaml` 与 `pnpm-workspace.yaml` 均不存在（依据：`ls pnpm-lock.yaml pnpm-workspace.yaml` → 两者 `No such file or directory`），锁文件是 `bun.lock`，且 `package.json:129` 钉死 `"packageManager": "bun@1.4.0"`。`--frozen-lockfile` 在无锁文件时必然报错。同一 owner 守卫（`:41`）使其当前被跳过，理由同上。

- `packages/telemetry/src/sink.ts:116,119` — 类别 1 · 中 — 说明：遥测上下文硬编码 `runtime: 'node'` 并上报 `node_version: process.versions.node`，但 CLI 运行在 Bun 上：`process.versions.node` 在 Bun 下返回的是 Bun 模拟的 Node 兼容版本号（不是真实运行时版本），`runtime` 也永远报不出 `bun`。类型侧无约束（`packages/telemetry/src/types.ts:3` 的 `TelemetryContext = Record<string, TelemetryPrimitive>`，`runtime` 是自由字符串）。依据：`packages/telemetry/src/sink.ts:116,119` vs `apps/kimi-code/tsdown.config.ts:19`（发布产物 shebang `#!/usr/bin/env bun`）、`apps/kimi-code/package.json:120-122`（`engines.bun = ">=1.4.0"`）。

- `packages/agent-core-v2/src/app/telemetry/cloudAppender.ts:180,183` — 类别 1 · 中 — 说明：与上一条同源的第二处遥测上下文，同样硬编码 `runtime: 'node'` 与 `node_version: process.versions.node`（依据：`packages/agent-core-v2/src/app/telemetry/cloudAppender.ts:180,183` vs `apps/kimi-code/tsdown.config.ts:19`）。两处是同一缺陷的两个副本，修一处需同时改另一处。

- `apps/kimi-code/README.md:39` — 类别 3 · 中 — 说明：README 声称 npm 安装路径的运行时要求是 Node（「If you prefer npm, use Node.js 22.19.0 or later」），但该包实际要求 Bun：`apps/kimi-code/package.json:120-122` 的 `engines` 只有 `{"bun": ">=1.4.0"}`、没有任何 node 字段，发布产物 `dist/main.mjs` 的 shebang 是 `#!/usr/bin/env bun`（`apps/kimi-code/tsdown.config.ts:19`），同仓 `docs/en/guides/getting-started.md:61` 也写「The CLI itself runs on Bun, not Node.js … Bun >= 1.4 must be present on your `PATH` to run `kimi`」。`22.19.0` 这个版本号在全仓只出现在本行与 `packages/node-sdk/README.md:17`，任何 package.json 都未声明。

- `DEVELOP.md:439` — 类别 3 · 中 — 说明：文档声称 pi-tui 的 node:test 套件「still runs under Node」，但 CI 实际在 Bun 下跑它：`.github/workflows/ci.yml:82` 是 `cd packages/pi-tui && bun --bun run test`，而 `packages/pi-tui/scripts/test.mjs:11` 在 Bun 下派发的是 `bun test`（只有真 Node 才走 `node --test`）。同一份 `DEVELOP.md` 的 `:343` 写的是「dispatches to `bun test` under Bun, `node --test` under Node」，两处自相矛盾。

- `docs/en/reference/kimi-command.md:345` — 类别 3 · 中 — 说明：文档声称「For global npm, pnpm, yarn, and bun installations, `kimi upgrade` shows update options」，但代码里没有 pnpm 这条安装来源：`apps/kimi-code/src/cli/update/types.ts:6-12` 的 `InstallSource` 只有 `npm-global | yarn-global | bun-global | homebrew | native | unsupported`，`apps/kimi-code/src/cli/update/preflight.ts:73-147` 的 `installCommandFor` / `canAutoInstall` / `spawnForSource` 三个 switch 与 `:215-230` 的 `renderManualUpdateMessage` switch 都没有 pnpm 分支，整个 `apps/kimi-code/src/cli/update/` 目录 grep `pnpm` 零命中。pnpm 全局安装会被判为 `unsupported`，只打印手动命令。

- `docs/zh/reference/kimi-command.md:345` — 类别 3 · 中 — 说明：中文版同一句「对全局 npm、pnpm、yarn、bun 安装，`kimi upgrade` 会展示更新选项」同样为假，依据同上（`apps/kimi-code/src/cli/update/types.ts:6-12`、`preflight.ts:73-147`）。

- `apps/kimi-web/src/style.css:448` — 类别 2 · 中 — 说明：注释声称存在一个 `pnpm dev:web` 开发命令（「recolors the logo mark golden-yellow so a `pnpm dev:web` tab is visually distinct from production」），但全仓没有 `dev:web` 脚本：根 `package.json:27-65` 的 scripts 里只有 `dev:cli` / `dev:server` / `dev:kap-server` / `dev:v2` / `dev:docs` 等，`rg 'dev:web'` 全仓唯一命中是 `apps/vscode/package.json:251` 的 `dev:webview`（不同脚本）。包管理器也不是 pnpm（`package.json:129` 为 `bun@1.4.0`）。

- `apps/kimi-web/src/components/Sidebar.vue:1000` — 类别 2 · 中 — 说明：同一处 `pnpm dev:web` 断言在组件里重复（「Dev-only: tint the mark yellow so a `pnpm dev:web` tab is obvious at a glance」），同样指向不存在的脚本（依据：根 `package.json:27-65` 无 `dev:web`；`rg 'dev:web'` 仅命中 `apps/vscode/package.json:251` 的 `dev:webview`）。

- `apps/kimi-web/vite.config.ts:12-13` — 类别 2 · 低 — 说明：注释声称后端由根 `pnpm dev:server`（端口 58627）与 `pnpm dev:v2`（端口 58628）启动，脚本名存在但运行器写错：根 `package.json:33` 是 `"dev:server": "cd apps/kimi-code && bun run dev:server"`、`package.json:35` 是 `"dev:v2": "cd apps/kimi-code && bun run dev:kap-server:multi"`，仓库无 pnpm 工作区（无 `pnpm-workspace.yaml`），`pnpm dev:server` 无法执行。

- `apps/kimi-web/vite.config.ts:137` — 类别 2 · 低 — 说明：注释声称测试经 `pnpm vitest run --project @moonshot-ai/kimi-web` 运行，但不存在名为 `@moonshot-ai/kimi-web` 的 vitest project：根 `vitest.config.ts:6-14` 的 `projects` 列表不含 `apps/kimi-web`，全仓无 `vitest.workspace.*` 文件，`apps/kimi-web` 自身也没有 vitest 配置文件（`ls apps/kimi-web/vitest.config.*` → 无）。该 `--project` 选不中任何项目。实际测试入口是 `.github/workflows/ci.yml:124` 的 `cd apps/kimi-web && bun --bun run test`。

- `scripts/check-locale-keys.mjs:85` — 类别 2 · 中 — 说明：注释声称这里有一个用 `createRequire` 加载 CommonJS TS 文件的回退（「Fallback: use require via createRequire for CommonJS TS files」），但该 `catch` 块体是空的——只有这一行注释，没有任何语句；文件里既没有 `createRequire` 导入也没有任何 `require(` 调用（依据：`rg 'createRequire|require\(' scripts/check-locale-keys.mjs` 唯一命中就是 `:85` 这行注释本身；文件 `:11-13` 的 import 只有 `node:module` 的 `register`、`node:path`、`node:url`）。注释描述的回退不存在。

- `packages/pi-tui/native/win32/build.mjs:204` — 类别 2 · 中 — 说明：`--help` 打印的用法行声称构建命令是 `npm --prefix packages/tui run build:native:win32`，但 `packages/tui` 目录不存在（本包在 `packages/pi-tui`，见 `packages/pi-tui/package.json:2` 的 `"name": "@moonshot-ai/pi-tui"`），且 `packages/pi-tui/package.json:53-58` 的 scripts 只有 `build` / `typecheck` / `test` / `clean`，没有 `build:native:win32`（`rg 'build:native' packages/pi-tui/` 只命中本行与 `native/linux/README.md:12`）。照此用法行执行必然失败。

---

## 交叉引用（同目录其他 findings 文件已覆盖，不重复计数）

- `packages/pi-tui/native/linux/README.md:12`、`:17`、`packages/pi-tui/native/win32/README.md:24`、`packages/pi-tui/UPSTREAM.md:73`、`packages/pi-tui/README.md:769,776,779,782,790` — 已由 `pi-tui-docs.md` 报告（含 `packages/tui` 路径错误与 `pnpm --filter` 失效）。我的独立判定与之一致。
- `scripts/check-locale-placeholders.cjs:1`（`#!/usr/bin/env node`）、`scripts/check-locale-keys.mjs:7`、`scripts/check-t-call-coverage.mjs:5`、`scripts/scan-hardcoded-v2.mjs:13` — 已由 `comments-scripts-plugins-review.md` 报告。我的独立判定与之一致。

---

## 判定为「成立 / 非缺陷」的命中点（避免误报，列出以便复核）

### `createRequire` / `require(` / `__dirname` / `__filename`

- **原生插件加载器（刻意写法，理由仍成立）**：`packages/kimi-native-tools/index.js:7-8,16,23,30,37,49,59`、`packages/kosong/native/index.js:7-8,20,38-266`、`apps/kimi-code/src/native/native-require.ts:1,13,20`、`apps/kimi-code/src/i18n/index.ts:13,25,102,114-116`。四者都是加载 `.node` 原生绑定，Bun 实现了 `createRequire` 与 CJS `require`，判定成立。
- **其他原生绑定加载点（不在排除名单，但同样成立）**：`packages/pi-tui/src/native-platform.ts:1,6`、`packages/pi-tui/src/native-module-path.ts:1,5`、`packages/kosong/src/native-tools.ts:11,13`、`packages/agent-core-v2/src/_base/native-tools.ts:1,3`、`apps/kimi-code/src/utils/clipboard/clipboard-native.ts:11,26`、`apps/kimi-code/src/native/smoke.ts:3,33`、`packages/kimi-agent/napi-debug.mjs:1-3`。均为 `createRequire(import.meta.url)` 加载可选原生模块，Bun 下可用。
- **ESM 里的裸 `require()`**：`packages/agent-core-v2/src/tool/native-glob-match.ts:7`、`packages/agent-core-v2/src/agent/knowledge/knowledgeService.ts:52`、`packages/i18n/src/i18n.ts:69`、`packages/kosong/src/providers/native-stream.ts:76`、`packages/kimi-agent/rust-loop.ts:245,314,484,1409,1456,1471`、`packages/agent-core-v2/src/app/workflow/workflowService.ts:185`。**实跑验证**：本机 Bun 1.4.2 下 `require("node:path")` 在 `.mjs` ESM 中返回正常模块（输出 `require-in-esm-ok function`），Bun 支持 ESM 中的 `require`，判定成立。
- **CJS 脚本**：`scripts/generate-locale-json.cjs:10-11,99,107,114`、`scripts/check-locale-placeholders.cjs:15,61,110-111`。`.cjs` 由 Bun 执行，`require` 原生可用。
- **构建/工具脚本**：`apps/vscode/tsdown.config.ts:1,8`、`apps/vscode/vitest.projects.ts:2,6`、`apps/vscode/scripts/vsix-package.mjs:2,16`、`apps/vscode/scripts/local-cli.mjs:4,6`、`packages/node-sdk/scripts/build-dts.mjs:4,7`、`packages/agent-core-v2/scripts/gen-contract-types.mjs:13,17-18,27`、`packages/agent-core-v2/scripts/debarrel.mjs:7-8`、`packages/agent-core-v2/scripts/generate-webp-dec-wasm.mjs:1,6,9`、`apps/kimi-code/scripts/native/01-bundle.mjs:1,6`、`apps/kimi-code/scripts/native/assets.mjs:3,47,216`、`apps/kimi-web/scripts/check-style.mjs:19-20`。均为 `createRequire` 解析包内 JSON/CLI 入口，Bun 下可用。
- **`import.meta.dirname` / `import.meta.filename` 替代 `__dirname`**：`scripts/check-locale-keys.mjs:15-17`、`scripts/check-t-call-coverage.mjs:13-15`、`packages/minidb/bench/reader-catchup.ts:51`、`packages/minidb/bench/cluster.ts:28`、`packages/minidb/test/cluster/helpers.ts:13`、`packages/minidb/test/e2e/crash-recovery.test.ts:20`、`packages/minidb/test/e2e/stress.test.ts:29`、`packages/agent-core-v2/test/lint/vendor-name-gates.test.ts:7`。Bun 实现了这两个字段，判定成立。
- **`__dirname` 的 CJS 垫片**：`apps/kimi-code/tsdown.config.ts:22-23`、`apps/vscode/tsdown.config.ts:40-41`、`packages/node-sdk/tsdown.config.ts:18-19`、`packages/kaos/tsdown.config.ts:13-14`。这是给打包产物注入的 `__dirname`/`__filename` 兼容垫片，Bun 下同样需要，判定成立。
- **`__dirname` 在 CJS 测试夹具/扩展宿主里**：`apps/vscode/test/extension-host/index.cjs:35`、`packages/pi-tui/test/fixtures/clipboard-worker-test.cjs:26,49`。CJS 文件，成立。
- **同名方法而非模块加载**：`packages/agent-core-v2/src/os/backends/host/hostEnvironmentService.ts:43,66,70,74,78,82,86,90,94` 的 `require` 是类方法名；`apps/vscode/test/vsix-package.test.ts:131-137`、`apps/vscode/scripts/vsix-verify.mjs:300` 明确测试「`this.require(...)` 不是运行时依赖」。不报。
- **worker 源码字符串里的 `require`**：`packages/agent-core-v2/src/features/codeRuntime/codeWorkerSource.ts:23-24`、`packages/minidb/test/worker-build.test.ts:243-362`、`packages/agent-core-v2/test/features/codeRuntime/codeRuntime.test.ts:85`、`packages/agent-core-v2/test/features/externalHooks/integration.test.ts:203,1098`、`packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts:3927`、`packages/kaos/test/fixtures/killtree.cjs:12,23-24`、`packages/kaos/test/local.test.ts:1008-1009`。是生成给子进程的源码文本，不是本进程的模块加载。

### npm / yarn / pnpm / npx（非测试文件）

- **`kimi upgrade` 的 npm/yarn 分支**：`apps/kimi-code/src/cli/update/preflight.ts:79-134,216-219`、`source.ts:47,50-51,61,66,81,85-86,90,101,159`、`types.ts:7-8`、`install-state.ts:9-10`。这是**引擎感知的自更新**，服务的是历史上用 npm/yarn 装过的用户，`DEVELOP.md:24` 明确记载「Self-update remains engine-aware for legacy SEA installs」。刻意设计，不报。
- **`apps/kimi-code/scripts/postinstall/{reach,postinstall,ui}.mjs`**：按硬性排除项跳过；抽查 `reach.mjs:40-48` 确实按 `npm_config_user_agent` 前缀识别 pnpm/yarn/npm，理由仍成立。
- **`packages/pi-tui` 的 node:test 套件与 `scripts/test.mjs` 的 Node 回退**：按硬性排除项跳过；`scripts/test.mjs:11` 的 `typeof Bun !== 'undefined' ? ['test', …] : ['--test', …]` 与 `packages/pi-tui/DEVELOP.md:22` 的说明一致，理由仍成立。
- **`apps/kimi-code/src/cli/sub/plugin-run-node.ts`**：按硬性排除项跳过；`apps/kimi-code/src/cli/commands.ts:136` 注册隐藏命令 `__plugin_run_node`，`packages/agent-core-v2/src/app/plugin/manager.ts:741-749` 在打包二进制下把插件的 `command: "node"` 重写为 `process.execPath` + `__plugin_run_node`。**因此 `plugins/official/kimi-datasource/kimi.plugin.json:8` 的 `"command": "node"` 与 `bin/kimi-datasource.mjs:1` 的 `#!/usr/bin/env node` 不是缺陷**（我最初列为候选，核实后撤回）。
- **npm 作为受支持的安装渠道**：`docs/en/guides/getting-started.md:13,17,51-52,61,164,167,170`、`docs/zh/guides/getting-started.md:13,17,51-52,61,164,167,170`、`README.md:51`、`README.zh-CN.md:53`、`apps/kimi-code/README.md:37-49`、`packages/node-sdk/README.md:14`。npm 是官方支持的安装方式，这些不是 Node 时代残留（`apps/kimi-code/README.md:39` 的 Node 版本要求除外，已单列）。
- **`npm run <script>` 作为通用脚本运行器**：`packages/minidb/README.md:37,76,77,345,394,413`、`packages/pi-tui/README.md:776,779`。脚本本身都存在（`packages/minidb/package.json` 的 `build`/`typecheck`/`test`/`bench`），`npm run X` 只是换了个运行器，断言不假，判定为弱、不报。
- **`pnpm` 出现在通用文件名/术语表/allowlist 里**：`apps/kimi-web/src/lib/filePathLinks.ts:53-54`（可链接的常见文件名集合）、`docs/DEVELOP.md:97-98`（中英术语对照表）、`tools/review/upstream-drift-allow.txt:11-12`、`tools/review/src/checks/upstream_drift.zig:60-70`（已退役锁文件的 allowlist）、`tools/review/src/checks/scripts_wiring.zig:239,378,388`（`bun run`/`npm run` 边标记）、`bunfig.toml:3`、`flake.nix:234`、`CONTRIBUTING.md:195,221`、`CONTRIBUTING.zh-CN.md:190,220`（描述 pnpm 时代与 Bun 的行为差异）。均为描述性文本，无假断言。
- **`npx` 作为 MCP server 示例**：`docs/en/customization/mcp.md:43`、`docs/zh/customization/mcp.md:43`、`apps/vscode/webview-ui/src/services/recommended-mcp.ts:17,25,33`、`apps/vscode/webview-ui/src/components/MCPServersModal.tsx:317`。MCP server 由用户自行配置、在用户机器上运行，推荐 `npx` 是产品选择而非对本仓代码的断言。
- **提示词/工具描述里的 npm 示例**：`packages/agent-core-v2/src/agent/tools/os/bash/bash.md:27,44`、`packages/agent-core-v2/src/features/skill/catalog/builtin/write-goal.md:30,76,78`、`packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts:105`。前两者是通用示例（「use whichever the project actually relies on」）；`profile-shared.ts:105` 列的 Bun 内置 API 我逐项对照 Bun 官方文档核实：`Bun.Image`（`https://bun.com/docs/runtime/image.md`）、`Bun.markdown`（`/runtime/markdown.md`）、`Bun.cron`（`/runtime/cron.md`）、`Bun.WebView`（`/runtime/webview.md`）均存在，`Bun.Terminal` 亦被本仓 `packages/agent-core-v2/src/os/backends/host/hostTerminalService.ts:31` 使用，断言成立，不报。
- **`undici-npm` 兼容模块**：`packages/kosong/src/http/undici-npm.ts:2`、`packages/agent-core-v2/src/_base/utils/undici-npm.ts:4,10`、`packages/agent-core-v2/src/_base/utils/proxy.ts:9`、`packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts:10`、`packages/agent-core-v2/src/app/auth/webSearch/engines/engine-undici.ts:1`、`engine-http.ts:2`。注释说的是「npm 上的 undici 包」而非 npm 工具，且 `.oxlintrc.json` 有对应的 `no-restricted-imports` 规则，成立。
- **`apps/kimi-code/scripts/native/01-bundle.mjs:13-15`**：注释称原生 tsdown 路径不经过 npm 的 `prebuild` 生命周期、而普通构建靠 `prebuild` 脚本生成 vis 资源。`apps/kimi-code/package.json:55` 确有 `"prebuild": "bun scripts/build-vis-asset.mjs"`，且 Bun 同样执行 pre/post 脚本，断言成立，不报。
- **`packages/kimi-native-tools/index.js:67`**：错误信息里的 `Run \`npm run build\` or \`cargo build --release\``，该包 `package.json` 确有 `"build": "napi build --platform --release --dts target/napi-generated.d.ts"`，断言成立，不报。
- **`packages/acp-server/src/version.ts:15`、`packages/node-sdk/src/types.ts:320`、`packages/kosong/src/catalog.ts` 与 `packages/agent-core-v2/src/{human/models-dev,app/kosongConfig}/modelsDev*.ts` 里的 `npm` 字段**：指 models.dev 目录里的 npm 包名字段，与包管理器无关。
- **`apps/kimi-web/README.md:105`、`apps/kimi-web/vite.config.ts:135-143` 的其余部分、`flake.nix:234`、`scripts/prompt-optimizer/src/benchmark/cases.ts:371`、`packages/pi-tui/native/linux/README.md:20` 与 `native/win32/README.md:28` 的 `node --test`**：前几项无假断言；后两项属 pi-tui node:test 套件（硬性排除项），且已由 `pi-tui-docs.md` 报告。

---

## 撤回的候选（核实后判定不是缺陷）

- `plugins/official/kimi-datasource/kimi.plugin.json:8` 的 `"command": "node"` 与 `plugins/official/kimi-datasource/bin/kimi-datasource.mjs:1` 的 `#!/usr/bin/env node` — 最初按「Node 时代残留」列为候选。核实后撤回：`packages/agent-core-v2/src/app/plugin/manager.ts:741-749` 在打包二进制下把 `command === 'node'` 重写为 `process.execPath` + `__plugin_run_node`（隐藏子命令，注册于 `apps/kimi-code/src/cli/commands.ts:136`，实现在 `apps/kimi-code/src/cli/sub/plugin-run-node.ts:7-20`），`:731-739` 还处理了 Electron 场景。属刻意设计。
- `DEVELOP.md:268` 的「CI installs no Node」 — 最初按「与 `.github/workflows/vscode-publish.yml:53` 的 `actions/setup-node@v6` 矛盾」列为候选。核实后撤回：该 job 带 `if: github.repository_owner == 'MoonshotAI'`（`.github/workflows/vscode-publish.yml:41`），本仓 origin 是 `7723qqq/kimi-code`，条件为假、job 被跳过，因此「CI 不装 Node」在本仓操作层面成立，断言不假。
