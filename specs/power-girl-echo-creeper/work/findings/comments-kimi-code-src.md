# Pass 2 — 注释审计：apps/kimi-code/src

范围：`apps/kimi-code/src/**` 下全部 TypeScript 源文件（374 个 `.ts`/`.tsx`，约 9114 条注释行）的注释。
方法：先全量抽取注释，按「可验证断言」过滤（命令、路径、数量、默认值、版本、符号名、控制流描述），再逐条回到源码行核对。
每条发现的两侧行号都已用 `sed -n '<line>p' <path>` 复现过。

## 发现

- `apps/kimi-code/src/cli/version.ts:24` — 类别 2 · 中 — 注释声称 dev 用 `tsx src/main.ts`、prod 用 `node dist/main.mjs` 运行本文件（第 25 行），但仓库已迁到 Bun：`dev` 是 `bun scripts/dev.mjs`（`apps/kimi-code/package.json:65`），`dev:prod` 是 `bun dist/main.mjs`（`apps/kimi-code/package.json:73`），且 `scripts/dev.mjs:48` 明确写着「no tsx intermediary needed」——`tsx` 现在只是未被任何脚本调用的 devDependency。（依据：`apps/kimi-code/package.json:65`、`apps/kimi-code/package.json:73`、`apps/kimi-code/scripts/dev.mjs:48`）

- `apps/kimi-code/src/cli/update/native-manifest.ts:6` — 类别 2 · 中 — 文件头注释断言 manifest 条目「point at the bare platform binary (`kimi-code-<target>[.exe]`), not an archive」（第 6-7 行），但本仓库实际发布的 `bun` 段条目指向的是 `.zip` 压缩包：`produce-manifest.mjs:104` 的注释写明 `kimi-code-bun-linux-x64.zip → linux-x64`，第 112 行把该 zip 名原样写进 `bun[target].filename`；测试 `release-artifacts.test.ts:194` 也断言 `filename: 'kimi-code-bun-darwin-arm64.zip'`，且第 197 行断言 manifest 根本没有 `platforms` 段。提交 9ce4828723 的说明更直接：「the manifest's `bun` entries keep their existing .zip filename semantics … Pointing those entries at the bare binary … is deliberately not done here」。（依据：`apps/kimi-code/scripts/native/produce-manifest.mjs:104`、`apps/kimi-code/scripts/native/produce-manifest.mjs:112`、`apps/kimi-code/test/scripts/native/release-artifacts.test.ts:194`）

- `apps/kimi-code/src/tui/components/media/diff-preview.ts:4` — 类别 2 · 低 — 注释声称「Reuses the diff algorithm from approval/DiffPreview.tsx」，但全仓库（含 git 历史）不存在任何 `DiffPreview.tsx`；该文件里的 diff 是本地实现（`computeLcsDiffLines` 在第 83 行、`computePrefixSuffixDiffLines` 在第 129 行），没有任何来自该路径的导入。（依据：`apps/kimi-code/src/tui/components/media/diff-preview.ts:83`、`apps/kimi-code/src/tui/components/media/diff-preview.ts:129`）

- `apps/kimi-code/src/cli/sub/acp.ts:19` — 类别 2 · 低 — 注释声称懒加载路由「mirroring the `kimi server run` v2 routing in `#/cli/sub/server/run.ts`」，但 `apps/kimi-code/src/cli/sub/server/` 目录已不存在（提交 ba74de7140 把 `sub/server/*` 整体改名为 `sub/web/*`），实际文件是 `apps/kimi-code/src/cli/sub/web/run.ts`。（依据：`apps/kimi-code/src/cli/sub/web/run.ts:1`）

- `apps/kimi-code/src/i18n/locales/en.ts:1723` — 类别 2 · 低 — 段落标记 `// sub/server/lifecycle.ts` 指向不存在的路径；同文件另有 8 处同类失效标记：第 1724、1741、1744、1745、1749、1753、1758、1958 行（`sub/server/run.ts`、`kill.ts`、`daemon.ts`、`rotate-token.ts`、`access-urls.ts`、`shared.ts`、`ps.ts`）。`sub/server/` 已整体改名为 `sub/web/`，且 `lifecycle.ts`、`daemon.ts`、`ps.ts` 在改名后也不存在。（依据：`apps/kimi-code/src/cli/sub/web/run.ts:1`、`apps/kimi-code/src/cli/sub/web/rotate-token.ts:1`、`apps/kimi-code/src/cli/sub/web/access-urls.ts:1`、`apps/kimi-code/src/cli/sub/web/shared.ts:1`）

- `apps/kimi-code/src/i18n/locales/zh.ts:1671` — 类别 2 · 低 — 与 en.ts 同源的失效段落标记，共 9 处：第 1671、1672、1689、1691、1692、1695、1699、1703、1890 行，全部指向已改名的 `sub/server/*`。（依据：`apps/kimi-code/src/cli/sub/web/run.ts:1`、`apps/kimi-code/src/cli/sub/web/rotate-token.ts:1`）

- `apps/kimi-code/src/tui/utils/token-speed.ts:75` — 类别 2 · 低 — 注释断言闭式误差「That is 3% at 900 tokens and 50–100% at 24, which is what the table shows」，但同一段注释上方 5 行的表格（第 70 行）写的是 24 tokens 时 `+29%`、900 tokens 时 `+0.6%`（第 65 行），与「50–100%」「3%」都对不上；第 89 行又给出第三个数字（~300 ms 窗口实测 33–37%）。「which is what the table shows」这一断言为假。（依据：`apps/kimi-code/src/tui/utils/token-speed.ts:65`、`apps/kimi-code/src/tui/utils/token-speed.ts:70`、`apps/kimi-code/src/tui/utils/token-speed.ts:89`）

## 已检查但未报告（避免误报）

- **Node 兼容语义的注释**：`cli/headless-exit.ts:13`、`main.ts:254`、`tui/kimi-tui.ts:1086`、`native/smoke.ts:96`、`tui/utils/status-line-command.ts:58`、`cli/update/source.ts:101`、`cli/update/preflight.ts:647` 里的「Node 会怎样」描述的是 Node 兼容语义（事件循环、SIGTERM 默认退出码、.cmd shim 的 EINVAL），Bun 同样成立，不报。
- **`globalThis.Bun` 只读断言**：`cli/update/source.ts:22` 称「under the real Bun runtime `globalThis.Bun` is read-only and permanently present」。本机 Bun 1.4.2 实测 `Object.getOwnPropertyDescriptor(globalThis, 'Bun')` 返回 `{writable:false, configurable:false}`，断言成立。
- **数值 / 默认值断言**：抽查的 `BRANCH_TTL_MS=5s` / `STATUS_TTL_MS=15s`（`utils/git/git-status.ts:14-15`）、`TIP_ROTATE_INTERVAL_MS=10s`（`tui/utils/tip-rotation.ts:4-5`）、图片 LRU 32×800²×4≈80MB（`tui/utils/image-pixels.ts:27-28`）、`DEFAULT_PAGE_SIZE=8`（`tui/utils/searchable-list.ts:16,22`）、上传并发/重试默认 3（`feedback/upload.ts:7-8,51,53`）、下载空闲超时 30s（`cli/update/native-stage.ts:306,320,324`）、ReadGroup/AgentGroup 节流 200ms（`read-group.ts:9,34`、`agent-group.ts:11,27`）、swarm 帧 80ms=12.5fps（`agent-swarm-progress.ts:22`）、状态行 300ms 上限（`status-line-command.ts:8,13`）、pi-tui 16ms 渲染节流（`packages/pi-tui/src/tui.ts:523`）、下载进度 10fps/32MB（`cli/sub/update-download.ts:154-155,167-168`）、`ACTIVITY_DETAIL_INDENT=1+2+1`（`tui/constant/rendering.ts:53-56`）、`TAIL_WINDOW_UNITS_PER_CELL` 的「ZWJ 家庭 emoji 约 11 单元/2 格」（`rendering.ts:36,38`）、`SURVEY_OPTION_COUNT=4` 与 `/^[0-3]$/`（`tui/constant/survey.ts:73,75`）、`MIN_SAMPLE_TOKENS=2` / `MIN_STEP_WINDOW_MS=500` / `windowTokens=outputTokens-1`（`tui/utils/token-speed.ts:104,121,154`）、`CACHE_BREAK_DROP_RATIO=0.95` + `CACHE_BREAK_MIN_DROP_TOKENS=2000`（`tui/controllers/cache-hint-controller.ts:67-70,146-147`）、`SWAP_CLAIM_STALE_MS=5min` 覆盖 30s smoke 超时（`cli/update/native-swap.ts:80-84,102`）、`formatStatDuration` 的 `0.9s`/`3m6s`/`1h2m`/`0s`（`tui/utils/session-stats.ts:93-94`）、`formatTokenCount` 的「262144 → 256k」（`utils/usage/usage-format.ts:14`）、`formatTokenSpeed` 的 100 阈值（`session-stats.ts:124,136`）、`tokens.rs` 的 ASCII 4/非 ASCII 1（`packages/kimi-native-tools/src/tokens.rs:4-5` 对 `session-event-handler.ts:163-164`）、`SPINNER_INTERVAL_MS=80`×10 帧≈800ms（`migration/migration-screen.ts:37-38`）、`undici` 默认 header 超时 300s（`constant/app.ts:128-129`）—— 全部与代码一致。
- **注释里反引号标识符**：脚本比对全部 298 个反引号标识符与非注释代码，无一缺失。
- **注释引用的路径**：`#/` 模块路径（`#/constant/app`、`#/utils/plugin-marketplace`）、跨包路径（`packages/agent-core-v2/src/features/plan/tools/exit-plan-mode/exitPlanModeTool.ts`、`.../exitPlanModeReview.ts`、`.../app/plugin/manager.ts`、`.../mcpCore/tool-naming.ts`、`.../llm-adapter/model/thinking.ts`、`packages/kap-server/src/i18n.ts`、`apps/kimi-web/src/lib/sessionStats.ts`）、`scripts/*`（`scripts/dev.mjs`、`scripts/build-vis-asset.mjs`、`scripts/native/bun-entry.ts`）、`.agents/skills/write-tui/DESIGN.md`（含 §5）全部存在，注释对其中符号（`pluginMcpRuntimeName`、`sanitizeMcpNamePart`、`resolveThinkingEffortForModel`、`tokensPerSecond`）的描述也与代码一致。
- **斜杠命令与 CLI 标志引用**：`/clear`（`tui/commands/registry.ts:330` 的 `new` 别名）、`/skill:<name>`（`tui/commands/resolve.ts:127`）、`--resume`（`cli/commands.ts:53`）均真实存在；`/dance`、`/rev`、`/goalfoo` 是彩蛋或示例。
- **键位断言**：Ctrl+B 回退到 readline backward-char（`custom-editor.ts:157` 对 `custom-editor.ts:520-523`）、Ctrl+T/Ctrl+N 的消费条件、Ctrl+S 转向语义、Shift-Tab 的 `none → plan → spec → none` 循环（`editor-keyboard.ts:276` 对 `editor-keyboard.ts:961-965`）全部一致。
- **`inline-skill-tokens.ts:2` 的 `/tokens`**：读作「inline skill tokens」时是排版歧义，读作斜杠命令时无此命令；属笔误而非行为不符，不作为发现。
- **`node:` 内置模块导入、`@types/node`、原生插件加载器的 `require()`/`createRequire`**：按硬性排除规则不报。

## 覆盖说明

- 已读：`apps/kimi-code/src` 下 374 个 `.ts`/`.tsx` 文件的注释（约 9114 条注释行），排除 `dist-web/`。
- 未逐字通读全部文件，而是先做全量注释抽取，再按可验证断言（命令 / 路径 / 数量 / 默认值 / 版本 / 符号名 / 控制流）过滤后逐条核对；纯风格化与冗余注释按规则不计入。
- 本文件只写发现，未修改仓库任何其它文件。
