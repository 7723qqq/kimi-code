# Pass 2 — packages/** TypeScript 注释审计

范围：`packages/**` 下全部 `.ts` / `.tsx` 源文件的注释，排除 `packages/agent-core-v2`、`packages/kap-server`、`packages/transcript`（无注释区，由 `scripts/check-no-comments.mjs` 单独覆盖）。
方法：用 TypeScript 编译器 API 抽取全部 15658 条注释（768 个文件），再按「含可验证断言」的模式过滤（数字/默认值、路径、命令、版本、符号名、控制流），逐条回读代码核对。
所有行号均已用 `sed -n '<line>p' <path>` 复核。

## 类别 1 — Node 时代写法，在 Bun 下不成立

- `packages/oauth/src/custom-registry.ts:263` — 类别 1 · 中 — 注释声称省略 `userAgent` 时请求回落到「运行时默认（`User-Agent: node`）」；实测 Node 的 `fetch` 默认 UA 确为 `node`，但 Bun 1.4.2 的默认 UA 是 `Bun/1.4.2`，而代码只在显式传入时才设置该头（依据：`packages/oauth/src/custom-registry.ts:273-274`）。
- `packages/oauth/src/refreshProviderModels.ts:52` — 类别 1 · 中 — 同一断言（`RefreshProviderHost.userAgent` 的文档注释）；实际发请求处同样只在显式传入时设置 UA，Bun 下真实 UA 为 `Bun/<version>`（依据：`packages/oauth/src/custom-registry.ts:273-274`）。
- `packages/node-sdk/src/catalog.ts:51` — 类别 1 · 中 — 同一断言（`fetchCatalog` 的 `userAgent` 文档注释）；代码为 `if (userAgent !== undefined) headers['User-Agent'] = userAgent;`，Bun 下未设置时由运行时补 `Bun/<version>`（依据：`packages/node-sdk/src/catalog.ts:59`）。
- `packages/pi-tui/test/viewport-overwrite-repro.ts:5` — 类别 1 · 低 — 注释给出的运行命令是 `npx tsx packages/tui/test/viewport-overwrite-repro.ts`（第 9 行的 tmux 示例同）；仓库以 Bun 为脚本运行器，且该路径不存在，文件实际在 `packages/pi-tui/test/`（依据：`packages/pi-tui/test/viewport-overwrite-repro.ts:4`）。
- `packages/pi-tui/test/alt-screen-large-transcript-bench.ts:17` — 类别 1 · 低 — 注释给出的运行命令是 `node --experimental-strip-types packages/tui/test/alt-screen-large-transcript-bench.ts`；仓库以 Bun 为运行时，且路径应为 `packages/pi-tui/test/`（依据：`packages/pi-tui/package.json:56` 的 `test` 脚本走 `bun scripts/test.mjs`）。
- `packages/pi-tui/test/image-test.ts:20` — 类别 1 · 低 — 用法提示写 `Usage: npx tsx test/image-test.ts [path-to-image.png]`；仓库以 Bun 为脚本运行器，同包其他脚本一律 `bun ...`（依据：`packages/pi-tui/package.json:56`）。

## 类别 2 — 注释与所描述代码不符

- `packages/klient/src/contract/global/models.ts:5` — 类别 2 · 高 — 注释声称 `ProtocolSchema` 是「the four real wire protocols」（四个真实 wire protocol）；实际枚举有五个：`anthropic` / `openai` / `openai_responses` / `google-genai` / `antigravity`（依据：`packages/klient/src/contract/global/models.ts:16-22`，以及引擎侧 `packages/agent-core-v2/src/llm-adapter/protocol/protocol.ts:10-16`）。
- `packages/kimi-agent/rust-loop.ts:3-4` — 类别 2 · 高 — 注释声称「`agent.engine = "rust"` 配置键不存在」（因此 Rust 引擎未接入）；实际该键存在且是 `KimiConfigSchema` 的一部分：`engine: z.enum(['js','rust']).default('js')`，并被 `agent: AgentConfigSchema.optional()` 挂进顶层 schema，`toml.ts` 还会把 `agent` 段写回 config.toml（依据：`packages/node-sdk/src/config/schema.ts:222`、`packages/node-sdk/src/config/schema.ts:458`、`packages/node-sdk/src/config/toml.ts:543`）。同句后半「`createRunTurnOverride` has no importers」为真（依据：`packages/kimi-agent/rust-loop.ts:748` 是唯一定义处）。
- `packages/acp-server/vitest.config.ts:25` — 类别 2 · 中 — 注释声称本文件「Mirrors `packages/server-v2/vitest.config.ts`」；`packages/server-v2` 已改名为 `kap-server`，该路径不存在，对应文件是 `packages/kap-server/vitest.config.ts`（依据：`packages/kap-server/vitest.config.ts` 存在，`packages/server-v2/` 不存在）。
- `packages/acp-server/src/session.ts:1113` — 类别 2 · 中 — 注释指向 `agent/plan/planOps.ts`；该文件实际位于 `features/plan/` 下（依据：`packages/agent-core-v2/src/features/plan/planOps.ts` 存在，`packages/agent-core-v2/src/agent/plan/` 不存在）。
- `packages/acp-server/src/convert.ts:87` — 类别 2 · 中 — 注释声称 agent-core-v2 的 prompt 管线在 `agent/prompt/promptService.ts`；全仓库不存在任何 `promptService.ts`（依据：`find packages -name 'promptService.ts'` 无结果；`packages/agent-core-v2/src/agent/prompt/` 下只有 `errors.ts` / `messageContent.ts` / `promptEvents.ts` / `promptMetadataText.ts`）。
- `packages/klient/src/contract/agent/events.ts:6` — 类别 2 · 中 — 注释声称 payload 形状镜像 `protocol/src/events.ts`；`packages/protocol` 包已在 commit `9188d03c99` 中删除，该路径不存在（依据：`git ls-tree -r --name-only HEAD packages/protocol` 为空）。
- `packages/klient/src/contract/agent/schemas.ts:7` — 类别 2 · 中 — 同一失效引用 `protocol/src/events.ts`（依据：同上）。
- `packages/klient/src/contract/agent/schemas.ts:196` — 类别 2 · 中 — 同一失效引用 `protocol/src/events.ts`（依据：同上）。
- `packages/klient/src/contract/global/catalog.ts:6` — 类别 2 · 中 — 注释声称 wire 形状镜像 `protocol/src/modelCatalog.ts` 与 `protocol/src/rest/modelCatalog.ts`；两者都不存在（`packages/protocol` 已删除；现存的是 `packages/kap-server/src/protocol/rest-modelCatalog.ts`）（依据：`git ls-tree -r --name-only HEAD packages/protocol` 为空）。
- `packages/klient/src/contract/global/hostFs.ts:4` — 类别 2 · 中 — 注释声称 wire 形状镜像 `protocol/src/rest/fsBrowse.ts`；该路径不存在（依据：同上）。
- `packages/klient/src/contract/global/auth.ts:4` — 类别 2 · 中 — 注释声称 wire 形状镜像 `protocol/src/rest/oauth.ts`；该路径不存在（依据：同上）。
- `packages/pi-tui/test/viewport-overwrite-repro.ts:4` — 类别 2 · 中 — 注释指示「Place this file at: packages/tui/test/viewport-overwrite-repro.ts」；文件实际位于 `packages/pi-tui/test/`，`packages/tui/` 不存在（依据：`packages/pi-tui/test/viewport-overwrite-repro.ts` 存在）。
- `packages/pi-tui/test/render-churn-bench.ts:16` — 类别 2 · 低 — 注释指示「Run from packages/tui: node test/render-churn-bench.ts」；目录实际是 `packages/pi-tui`（依据：`packages/pi-tui/test/render-churn-bench.ts` 存在）。
- `packages/minidb/src/cluster/types.ts:4` — 类别 2 · 中 — 注释声称设计见 `plan/minidb-cluster-plan.md`；仓库内不存在任何 `plan/` 目录或该文件（依据：`find . -type d -name plan` 只返回 `packages/agent-core-v2/src/features/plan` 等无关目录）。
- `packages/minidb/bench/open-lifecycle.ts:3` — 类别 2 · 中 — 注释声称这是「Phase-1 baseline (plan/01-baseline-and-boundaries.md)」；该文件不存在（依据：同上）。
- `packages/minidb/bench/bench.ts:9` — 类别 2 · 中 — 注释给出的运行方式是 `node --import tsx bench/bench.ts`，而包自己的脚本是 `bun bench/bench.ts`；同一模式还出现在 `packages/minidb/bench/baseline.ts:15`、`maintenance.ts:9-11`、`measure-session-memory.ts:13`、`message-composed.ts:18`、`message-range.ts:18`、`open-lifecycle.ts:16-18`、`reader-catchup.ts:14,25`、`search-baseline.ts:10`、`session-children.ts:25`、`session-store-demo.ts:4`，以及 `packages/minidb/src/server.ts:289`（依据：`packages/minidb/package.json:50-52`）。
- `packages/minidb/test/cluster/mp-worker.ts:4` — 类别 2 · 低 — 注释声称该 worker「spawned via `node --import tsx mp-worker.ts <mode> ...`」；实际 spawn 用 `process.execPath`，且只在非 Bun 运行时才追加 `--import tsx`，Bun 下等价命令是 `bun mp-worker.ts`（依据：`packages/minidb/test/cluster/helpers.ts:49-52`）。`packages/minidb/test/cluster/concurrent.test.ts:4` 有同一表述。
- `packages/klient/test/e2e/legacy/session-resume.test.ts:8` — 类别 2 · 中 — 注释声称该行为由 `services/src/message/messageService.ts:106` 修复；该路径在本仓库全部 20765 条提交历史中都不存在（依据：`git log --all -- 'services/src/message/messageService.ts'` 无输出）。
- `packages/klient/test/e2e/harness/ws.ts:56` — 类别 2 · 中 — 注释声称该模式移植自 `server/test/ws-handshake.e2e.test.ts:88-117`；该路径在本仓库历史中不存在（依据：`git log --all -- 'server/test/ws-handshake.e2e.test.ts'` 无输出）。
- `packages/pi-tui/vitest.config.ts:4` — 类别 2 · 低 — 注释把包的 `test` 脚本描述为 `node --test test/*.test.ts`；实际脚本是 `bun scripts/test.mjs`，它按运行时派发（Bun 下 `bun test`，Node 下 `node --test`）（依据：`packages/pi-tui/package.json:56`、`packages/pi-tui/scripts/test.mjs:1-2`）。

## 覆盖说明

- 已抽取并过滤：`packages/**` 下 768 个 `.ts`/`.tsx` 文件的 15658 条注释（排除 agent-core-v2 / kap-server / transcript）。
- 已逐条核对并**排除**的候选（均为误报，注释与代码一致）：acp-server 的「4 个 mode」「3 个 canonical 权限选项」「转义 5 个字符」「最多 3 个 config option」「六个 ACP builtins」；klient 的 IPC 30s 默认、e2e harness 的 5s/60s 默认；pi-tui stdin-buffer 的 50ms/10ms 默认、`drainInput` 的 1000ms/50ms 默认；node-sdk 的 bash 600s 与 MCP 30s 默认；i18n 的「只有 2 个 locale」；kosong 的「三态缓存」「三个 reasoning key 名」；`packages/kimi-agent/rust-loop.ts:146` 的 `rpc/types.rs`（文件确实存在于 `packages/kimi-agent/src/rpc/types.rs`）；`packages/klient/test/e2e/invalid-input-matrix.test.ts:46`（注释本身就在说明 `helpers/dual.ts` 已被删除）。
- 关于 pi-tui：本文件涉及的三个 pi-tui 文件（`test/viewport-overwrite-repro.ts`、`test/alt-screen-large-transcript-bench.ts`、`test/render-churn-bench.ts`）都是独立的 repro/bench 脚本，**不在**被排除的 node:test 套件内——`packages/pi-tui/scripts/test.mjs:6-7` 只收集 `*.test.ts`，这三个文件不匹配。`test/image-test.ts` 同理。
- 未覆盖：`packages/agent-core-v2`、`packages/kap-server`、`packages/transcript` 的注释（无注释区，另有检查）；`specs/`、`apps/kimi-code/dist-web/`、`参考目录/`、`node_modules/`、`**/dist/`。
