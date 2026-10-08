# Pass 2 — 注释审计：apps/vscode、apps/vis、apps/kimi-inspect、apps/kimi-web

范围：这四个目录下全部源文件（`.ts` / `.tsx` / `.vue` / `.mjs` / `.js`）的注释。
方法：抽取全部 8085 条注释（673 个文件），按「可验证断言」过滤（命令、路径、数量、默认值、版本、符号名、控制流描述），
再逐条回到源码行核对。每条发现的两侧行号都已用 `sed -n '<line>p' <path>` 复现过。

## 发现

- `apps/kimi-web/src/components/Sidebar.vue:1000` — 类别 1 · 低 — 注释声称开发时用 `pnpm dev:web` 打开的标签页会被染黄以便辨认，但仓库已无 pnpm（根 `package.json:129` 是 `"packageManager": "bun@1.4.0"`），且 `dev:web` 这个脚本名在任何 package.json 里都不存在（kimi-web 的开发脚本只有 `dev`，见 `apps/kimi-web/package.json:8`）。（依据：`package.json:129`、`apps/kimi-web/package.json:8`）

- `apps/kimi-web/vite.config.ts:12` — 类别 1 · 低 — 注释称 `default` 后端预设由根 `pnpm dev:server` 启动；脚本名存在但包管理器已换成 Bun，正确写法是 `bun run dev:server`（`package.json:33` 的脚本体本身就是 `bun run dev:server`）。（依据：`package.json:129`、`package.json:33`）

- `apps/kimi-web/vite.config.ts:13` — 类别 1 · 低 — 注释称 `multi` 预设由 `pnpm dev:v2` 启动；同上，应为 `bun run dev:v2`（`package.json:35`）。（依据：`package.json:129`、`package.json:35`）

- `apps/kimi-web/vite.config.ts:137` — 类别 1 · 中 — 注释称测试经 `pnpm vitest run --project @moonshot-ai/kimi-web` 运行；实际 kimi-web 不在根 vitest 的项目列表里（`vitest.config.ts:6-14` 只列了 packages/*、apps/kimi-code、apps/kimi-inspect、apps/vis/server、apps/vis/web 与 vscode 项目），它自己也没有 vitest 配置文件，CI 的运行方式是 `cd apps/kimi-web && bun --bun run test`（`.github/workflows/ci.yml:124`）。`--project @moonshot-ai/kimi-web` 匹配不到任何项目。（依据：`vitest.config.ts:6`、`.github/workflows/ci.yml:124`）

- `apps/kimi-web/test/clipboard.test.ts:4` — 类别 1 · 低 — 文件头的 `Run:` 指令写 `pnpm --filter @moonshot-ai/kimi-web test -- clipboard.test.ts`；kimi-web 被根 workspace 显式排除（`package.json:10` 的 `"!apps/kimi-web"`），仓库里也没有 pnpm-workspace.yaml，`pnpm --filter` 无法解析到这个包。实际运行方式是 `cd apps/kimi-web && bun run test`。（依据：`package.json:10`、`.github/workflows/ci.yml:124`）

- `apps/kimi-web/test/daemon-client.test.ts:5` — 类别 1 · 低 — 同上：`pnpm --filter @moonshot-ai/kimi-web exec vitest run ...` 在 Bun 仓库里不成立。（依据：`package.json:10`、`package.json:129`）

- `apps/kimi-web/test/event-batcher.test.ts:7` — 类别 1 · 低 — 同上：`pnpm --filter @moonshot-ai/kimi-web exec vitest run ...`。（依据：`package.json:10`、`package.json:129`）

- `apps/kimi-web/test/session-stats.test.ts:8` — 类别 1 · 低 — 同上：`pnpm --filter @moonshot-ai/kimi-web exec vitest run ...`。（依据：`package.json:10`、`package.json:129`）

- `apps/kimi-web/test/task-poller.test.ts:6` — 类别 1 · 低 — 同上：`pnpm --filter @moonshot-ai/kimi-web exec vitest run ...`。（依据：`package.json:10`、`package.json:129`）

- `apps/kimi-web/test/trajectory.test.ts:5` — 类别 1 · 低 — 同上：`pnpm --filter @moonshot-ai/kimi-web exec vitest run ...`。（依据：`package.json:10`、`package.json:129`）

- `apps/kimi-web/test/workspace-state.test.ts:4` — 类别 1 · 低 — 同上：`pnpm --filter @moonshot-ai/kimi-web exec vitest run ...`。（依据：`package.json:10`、`package.json:129`）

- `apps/kimi-web/src/composables/messagesToTurns.ts:269` — 类别 2 · 低 — 注释称这里内联的 `buildApprovalBlock`「mirrors the one in useKimiWebClient.ts」；该函数已抽到 `apps/kimi-web/src/lib/approvalView.ts:19`，`useKimiWebClient.ts:11` 现在只是从那里 import，本文件镜像的对象已不在注释所指的文件里。（依据：`apps/kimi-web/src/lib/approvalView.ts:19`、`apps/kimi-web/src/composables/useKimiWebClient.ts:11`）

- `apps/kimi-web/src/composables/useKimiWebClient.ts:2` — 类别 2 · 中 — 注释称本文件是「the only place that imports both src/api/* and src/types.ts」；实际至少还有四个文件同时 import 两者：`useFilePreview.ts:8-9`、`useSideChat.ts:12-14`、`useModelProviderState.ts:10-27`、`useWorkspaceState.ts:12-46`。（依据：`apps/kimi-web/src/composables/useFilePreview.ts:8`、`apps/kimi-web/src/composables/client/useWorkspaceState.ts:12`）

- `apps/kimi-web/src/lib/rootKey.ts:14` — 类别 2 · 中 — 注释称本函数镜像服务端的两份实现，其中一份写作 `agent-core session/store/workdir-key.ts`，并说「keep the three in sync」；仓库里根本没有 `packages/agent-core` 这个包（`packages/` 下只有 `agent-core-v2`），全仓库也不存在任何 `workdir-key.ts`，实际只有两份实现（另一份是 `packages/agent-core-v2/src/_base/utils/workdir-slug.ts:27` 的 `workspaceRootKey`）。（依据：`packages/agent-core-v2/src/_base/utils/workdir-slug.ts:27`）

- `apps/kimi-web/src/components/SessionRow.vue:367` — 类别 2 · 低 — 注释称行高 = 标题行高（13×1.25≈16px）+ 2×5px 的 `.se` padding ≈ 26px；`.se` 实际是 `padding: 8px var(--space-2)`（`SessionRow.vue:344`），行高 ≈ 16.25 + 16 ≈ 32px。该注释与 8px 的 padding 是同一次提交（c2661c4ed4）引入的，从写下起就不成立。（依据：`apps/kimi-web/src/components/SessionRow.vue:344`）

- `apps/kimi-web/src/components/WorkspaceGroup.vue:275` — 类别 2 · 低 — 注释称表头高度 = 名称行高（13×1.25≈16px）+ 2×5px 的 `.gh` padding ≈ 26px；`.gh` 实际是 `padding: 8px calc(var(--sb-pad-x) - var(--sb-inset))`（`WorkspaceGroup.vue:254`），高度 ≈ 32px。（依据：`apps/kimi-web/src/components/WorkspaceGroup.vue:254`）

- `apps/kimi-web/src/components/chat/Composer.vue:2296` — 类别 2 · 低 — 注释称移动端块里「`.cin` 容器去掉边框并变成 flex row，textarea 自己变成胶囊输入框」；`.cin` 这个类在仓库里已不存在（容器现在是 `.composer-card`，`Composer.vue:1369`，仍保留 `border: 1px solid var(--line)` 且不是 flex 容器），紧随其后的移动端块（`Composer.vue:2300-2307`）也只改了 `--composer-send-size`、`max-width` 和 `.input-row` 的 gap，没有做注释描述的两件事。（依据：`apps/kimi-web/src/components/chat/Composer.vue:1369`、`apps/kimi-web/src/components/chat/Composer.vue:2300`）

- `apps/kimi-web/src/components/chat/Composer.vue:2424` — 类别 2 · 低 — 注释称 scoped 的 `.cin` 规则输给了 base `.cin` 的层叠才被搬到全局表；`.cin` 类已不存在（同上），全局表里对应的块（`style.css:796-799`）描述的是「the base rules」而不是 `.cin`。注释里唯一仍然成立的部分是「覆盖写在 style.css」。（依据：`apps/kimi-web/src/style.css:796`）

- `apps/kimi-web/src/composables/useKimiWebClient.ts:2550` — 类别 2 · 低 — 注释称 `clearWorkingFlags` 是「the ONLY writer of `turnActiveBySession` outside the reducer / snapshot seed」，也是 `finishPromptLocal` / 各入口错误路径之外唯一清 `inFlightBySession` 的地方；`forgetSession` 同样会删掉这两个键（`useKimiWebClient.ts:589-590`），它既不是 reducer、也不是 snapshot seed、也不是 `finishPromptLocal`。（依据：`apps/kimi-web/src/composables/useKimiWebClient.ts:589`）

## 已检查但未报告（避免误报）

- **`node:` 内置模块导入**：按仓库 lint 规则 `unicorn/prefer-node-protocol: error` 要求，且 Bun 已实现，不报。
- **注释里反引号标识符**：脚本比对全部反引号标识符与仓库标识符集合，无一缺失，全部存在。
- **注释引用的源码路径**：`packages/agent-core-v2/src/agent/task/persist.ts`、`.../microCompaction/microCompactionOps.ts`、`.../features/cron/cronService.ts`、`.../_base/log/fileLog.ts`、`.../agent/contextMemory/loopEventFold.ts`、`.../llm-adapter/contract/tokens.ts`、`.../session/sessionContext/sessionContext.ts`、`packages/kap-server/src/instanceRegistry.ts`、`packages/kimi-agent/rust-loop.ts`、`apps/kimi-code/src/tui/utils/token-speed.ts` 全部存在，注释对它们的描述也与代码一致。
- **数值/默认值断言**：抽查的 `--p-content-max: 760px`（Dialog xl）、MenuItem lg 的 44px、StateTree 的 150ms 关闭延迟、toolMeta 的 14px 图标、ConversationToc 的 3+10+220、`--space-3: 12px`、`.model-pill b` 的 280px、`--composer-send-size` 的 36px、IconButton sm 的 26px、`STALE_SOCKET_FLOOR_MS` 与 2× heartbeat、kap-server 的 10s heartbeat / 1001 / ~20s 回收、`CRON_ID_REGEX`、`estimateTokens` 公式、`fileLog` 轮转顺序、`decodeTokens = output - 1`、`FIRST_LOAD_AUTH_RETRY_MS = 2000`、错误码 40902/40904、`VALID_TASK_ID` 正则、`SizePreview` 的 120 字符截断、`SessionToolsDialog` 的 5 字段校验 —— 全部与代码一致。
- **`process.versions.node` / `runtime: 'node'` / `node --test` / Node shebang / `.nvmrc` / `engines.node` / `package-lock.json` / `yarn.lock` / `.npmrc`**：这四个 app 的注释里一处都没有。
- **`apps/kimi-web/src/components/chat/Markdown.vue:337/655/680` 的 markstream 版本断言**：注释写「since 1.0.9」，实际安装的是 `1.0.9-beta.1`；但注释描述的 `.code-action-btn` / `.code-block-shell-content` 类在已安装的 dist 里确实存在，行为描述成立，只算版本号措辞不精确，不作为发现。
- **`apps/kimi-web/src/composables/messagesToTurns.ts:429` 的「see renderCronFireXml in agent-core」**：函数确实存在（`packages/agent-core-v2/src/features/cron/internal/format.ts:18`），只是包名少写了 `-v2`，不作为发现。

## 覆盖说明

- 已读：`apps/vscode`（392 条注释）、`apps/vis`（933 条）、`apps/kimi-inspect`（663 条）、`apps/kimi-web`（6097 条），共 8085 条注释，来自 673 个源文件；排除 `node_modules`、`dist`、`dist-web`、`coverage`。
- 未逐字通读全部 673 个文件，而是先做全量注释抽取，再按可验证断言（命令 / 路径 / 数量 / 默认值 / 版本 / 符号名 / 控制流）过滤后逐条核对；纯风格化与冗余注释按规则不计入。
- 本文件只写发现，未修改仓库任何其它文件。
