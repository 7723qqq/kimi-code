# packages/pi-tui 文档审计（7 个 .md）

范围：`packages/pi-tui/README.md`、`DEVELOP.md`、`UPSTREAM.md`、`CHANGELOG.md`、`native/linux/README.md`、`native/win32/README.md`、`native/darwin/README.md`。
已核实为真、故未列入的断言（抽样）：overlay 默认 80 列与 anchor 取值/解析顺序（`src/tui.ts:1317`、`:200-210`、`:1336-1390`）、`PI_TUI_WRITE_LOG`（`src/terminal.ts:156`）、粘贴标记阈值 >10 行或 >1000 字符（`src/components/editor.ts:1475-1487`）、Ctrl+W/Alt+D/Ctrl+]/Ctrl+Alt+] 等键位（`src/keybindings.ts:107-137`）、README 的 utils 示例输出（用 bun 1.4.2 实跑 `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi` 全部一致）、CI job `test-pi-tui`（`.github/workflows/ci.yml:66`）、UPSTREAM.md 的 sixel 条目（`src/terminal-image.ts:6`、`:275-286`、`:709`、`src/tui.ts:33`、`:1025-1027`）与布局效果 10 次收敛抛错（`src/tui-alt-screen.ts:81`、`:1888-1891`）。

## 发现

- `packages/pi-tui/README.md:776` — 类别 1 · 高 — 文档要求「from monorepo root」执行 `npm install`，但仓库已迁移到 Bun：根 `DEVELOP.md:24` 写明「Bun 既是包管理器（hoisted workspace、`bun.lock`）……CI 不安装 Node」，根 `DEVELOP.md:280` 的安装命令是 `bun install`；仓库只有 `bun.lock`（无 package-lock.json / yarn.lock / pnpm-lock.yaml），且工作区包使用 npm 不支持的 `catalog:` 协议（`packages/agent-core-v2/package.json:74`），照文档执行会直接报错并可能生成竞争锁文件。

- `packages/pi-tui/README.md:779` — 类别 1 · 中 — 文档写 `npm run typecheck`，但脚本运行器是 Bun：根 `DEVELOP.md:289` 为 `bun run typecheck`，本包 `packages/pi-tui/package.json:55` 的 typecheck 脚本（`tsc -p tsconfig.json --noEmit`）应由 `bun run typecheck` 调用。

- `packages/pi-tui/README.md:769`（另见 `:782`、`:790`）— 类别 1 · 中 — 文档用 `npx tsx test/chat-simple.ts` 运行示例，但仓库的 TS 运行器是 Bun（根 `DEVELOP.md:24`「CI 不安装 Node」；`tsx` 只是根 `package.json:82` 的 devDependency），仓库内同类入口一律走 bun（`apps/kimi-code/package.json:65` `"dev": "bun scripts/dev.mjs"`）。

- `packages/pi-tui/UPSTREAM.md:73` — 类别 1 · 中 — 同步验收步骤写 `pnpm --filter @moonshot-ai/pi-tui test`，但 pnpm 工作区已被移除（根 `DEVELOP.md:24`「the former pnpm workspace setup … were retired」）；本包测试入口是 `packages/pi-tui/package.json:56` 的 `bun scripts/test.mjs`，CI 实际执行 `cd packages/pi-tui && bun --bun run test`（`.github/workflows/ci.yml:82`）。

- `packages/pi-tui/native/linux/README.md:20` — 类别 1 · 中 — 文档用 `node --test test/native-clipboard-linux.test.ts` 直接派发 node:test，绕过了本包测试入口 `packages/pi-tui/package.json:56` 的 `bun scripts/test.mjs`（`packages/pi-tui/scripts/test.mjs:11` 在 Bun 下派发 `bun test`），且仓库工具链不安装 Node（根 `DEVELOP.md:24`）。

- `packages/pi-tui/native/win32/README.md:28` — 类别 1 · 中 — 同上：`node --test test/native-platform.test.ts` 绕过 `packages/pi-tui/package.json:56` 的 `bun scripts/test.mjs` 入口，在 Bun-only 工具链下需要额外安装 Node。

- `packages/pi-tui/README.md:193` — 类别 3 · 高 — 文档称可用 `PI_HARDWARE_CURSOR=1` 打开硬件光标，但该变量在全仓库（除本行外）没有任何读取点；代码只提供构造参数与 setter（`packages/pi-tui/src/tui.ts:548` 构造函数第二参数、`packages/pi-tui/src/tui.ts:577` `setShowHardwareCursor`）。

- `packages/pi-tui/native/linux/README.md:12` — 类别 3（兼 1）· 高 — 文档给出的构建命令 `npm --prefix packages/tui run build:native:linux` 无法执行：`packages/tui` 目录不存在（本包在 `packages/pi-tui`，见 `packages/pi-tui/package.json:2`），且全仓库没有任何 `build:native:linux` 脚本（`packages/pi-tui/package.json:53-58` 只有 build/typecheck/test/clean）；实际构建入口是 `packages/pi-tui/native/linux/build.sh:1`。

- `packages/pi-tui/README.md:563` — 类别 3 · 中 — 文档称 `@` 前缀「Filters to attachable files」，但 `attachable` 一词全仓库只出现在这一行；`@` 补全走 fd 模糊搜索、不按扩展名或可附件类型过滤（`packages/pi-tui/src/autocomplete.ts:318-330` 调用 `packages/pi-tui/src/autocomplete.ts:778` 的 `getFuzzyFileSuggestions`）。

- `packages/pi-tui/README.md:329` — 类别 3 · 中 — 文档称 `Ctrl+Enter` 可换行，但换行分支只认 shift+enter / ctrl+j（`packages/pi-tui/src/keybindings.ts:143`）、Alt+Enter（`packages/pi-tui/src/components/editor.ts:1030`）与 `\x1b[13;2~`（`packages/pi-tui/src/components/editor.ts:1031`）；`ctrl+enter` 在 `packages/pi-tui/src` 中不存在，仅出现在测试（`packages/pi-tui/test/keys.test.ts:222`）。

- `packages/pi-tui/README.md:623` — 类别 3 · 中 — 文档把 `VirtualTerminal` 列为包的内置实现，但包入口只导出 `ProcessTerminal`（`packages/pi-tui/src/index.ts:92`）；`VirtualTerminal` 位于测试目录 `packages/pi-tui/test/virtual-terminal.ts:11`，且 `packages/pi-tui/package.json:26-30` 的 `files` 不含 test/，发布产物里没有它。

- `packages/pi-tui/native/linux/README.md:17` — 类别 3 · 中 — 文档说「run from `packages/tui`」，该目录不存在；本包目录是 `packages/pi-tui`（`packages/pi-tui/package.json:2`）。

- `packages/pi-tui/native/win32/README.md:24` — 类别 3 · 中 — 文档说「run from `packages/tui` in PowerShell」，该目录不存在；本包目录是 `packages/pi-tui`（`packages/pi-tui/package.json:2`）。

- `packages/pi-tui/README.md:606` — 类别 3 · 低 — 文档给出的 `Terminal` 接口清单不完整，缺少 4 个必需成员：`drainInput`（`packages/pi-tui/src/terminal.ts:90`）、`kittyProtocolActive`（`packages/pi-tui/src/terminal.ts:100`）、`setTitle`（`packages/pi-tui/src/terminal.ts:115`）、`setProgress`（`packages/pi-tui/src/terminal.ts:118`），照此清单实现无法满足接口。
