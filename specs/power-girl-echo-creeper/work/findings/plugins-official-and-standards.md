# 发现：plugins/official/** 与 scripts/prompt-optimizer/** 下的 .md

范围（5 个文件，全部通读并与实现比对）：

- `plugins/official/kimi-datasource/SKILL.md`
- `plugins/official/kimi-datasource/CHANGELOG.md`
- `plugins/official/kimi-webbridge/skills/kimi-webbridge/SKILL.md`
- `plugins/official/kimi-webbridge/skills/kimi-webbridge/references/operations.md`
- `scripts/prompt-optimizer/knowledge-rs/standards.md`

## 发现

- `scripts/prompt-optimizer/knowledge-rs/standards.md:139` — 类别 3 · 中 — 说明：文档声称「Node 版本不满足会让原生打包脚本（`bun run build:native:bun`）直接报错」，代码实际是整条原生打包流水线全程由 Bun 执行、没有任何 Node 版本校验：`build:native:bun` 只调 `resolveBun()` 起 bun（依据：`apps/kimi-code/scripts/native/build-bun.mjs:168`），bundle 步骤用 `process.execPath`（即 bun）跑 tsdown（依据：`apps/kimi-code/scripts/native/01-bundle.mjs:16`）；全仓库搜 `24.15` 只命中 `flake.nix:31` 与 standards.md 自身，且仓库自己的文档明确写「Node.js 不再被任何开发流程需要……CI 不装 Node」（依据：`DEVELOP.md:268`、`CONTRIBUTING.md:40`）。同句前半「需要 Node.js >= 24.15.0」只对 nix 构建路径成立（依据：`flake.nix:31`）。

- `scripts/prompt-optimizer/knowledge-rs/standards.md:67` — 类别 3 · 中 — 说明：文档（标题在 `standards.md:63`，scope 写 `packages/agent-core-v2/src/agent/`）声称该目录下的 `Agent` 类构造函数「不可强制要求创建 `Session` 实例，不可要求 `agentId` 或 `session`」，代码实际是该目录（50 个子目录、294 个文件，无顶层文件）里不存在任何名为 `Agent` 的类，全仓库 `class Agent` 零命中（只有 `Agent*Service` 等）；该条目描述的是已删除的 v1 包——v1 的 `export class Agent`（依据：`packages/agent-core/src/agent/index.ts:115`，`constructor(options: AgentOptions)` 在同文件 192 行）随 commit `bb16383aa1`（remove the legacy agent-core v1 package）一并删除，v2 中无对应物。

- `scripts/prompt-optimizer/knowledge-rs/standards.md:51` — 类别 3 · 低 — 说明：文档声称 apps/kimi-code「不可直接依赖 `@moonshot-ai/agent-core-v2`」，代码实际是该应用在 `cli/v2` 下直接 import 该包（依据：`apps/kimi-code/src/cli/v2/validate-config.ts:26`、`apps/kimi-code/src/cli/v2/run-v2-print.ts:62`）；仓库同一规则的权威版本带例外——「must **not** depend directly on `@moonshot-ai/agent-core-v2` outside the `cli/v2` runner」（依据：`DEVELOP.md:86`），standards.md 漏掉了这个例外，按字面读会把 cli/v2 的既有用法判成违规。

- `scripts/prompt-optimizer/knowledge-rs/standards.md:131` — 类别 3 · 低 — 说明：文档举例「闭包外的叶子包（如 e2e）即使缺失也不会报错」，代码实际是当前工作区里不存在任何 e2e 包（`packages/` 下 19 个目录无 e2e，全仓库无 `"name": "*e2e*"` 的 package.json）；该例子指向的 `packages/server-e2e` 已在 commit `187519f3bb` 中删除（依据：`scripts/check-nix-workspace.mjs:14` 的 `START_PKG = '@moonshot-ai/kimi-code'` 与同文件 3–4 行注释确认闭包范围，但例子已失效）。

## 已核实为真、未报告（避免误报）

- kimi-datasource 的 SKILL.md 与实现逐条对得上：工具名 `mcp__plugin-kimi-datasource_data__get_data_source_desc` / `__call_data_source_tool`（`SKILL.md:5`、`SKILL.md:14`–`SKILL.md:15`）与 `mcpCore/tool-naming.ts:6`–`mcpCore/tool-naming.ts:11` 的 sanitize 规则一致（`plugin-kimi-datasource:data` 的 `:` → `_`，全名 54/55 字符 < 64 上限）；25 个数据源（`SKILL.md:27`–`SKILL.md:51` 表格）与 `bin/kimi-datasource.mjs:62`–`bin/kimi-datasource.mjs:88` 的 enum 逐行一致；`SKILL.md:23` 的「25 个」计数正确；OAuth 隔离凭据（`SKILL.md:19`）对应 `bin/kimi-datasource.mjs:291`–`bin/kimi-datasource.mjs:307`；`SKILL.md:146` 的 `_a.csv`/`_hk.csv` 拆分对应 `bin/kimi-datasource.mjs:224`–`bin/kimi-datasource.mjs:238` 的 `allowedResponseFilePath`；`${KIMI_SKILL_DIR}`（`SKILL.md:152`）确由 `packages/agent-core-v2/src/features/skill/catalog/registry.ts:168` 注入，`watchlist.json` 存在。
- kimi-datasource 的 CHANGELOG.md：3.4.0 的「thirteen data sources」= 3 + 8 + 2 正确（`CHANGELOG.md:5`）；3.3.0 的「five」正确（`CHANGELOG.md:9`）；3.1.0 的 `query_stock` 已移除、当前只有两个工具（`CHANGELOG.md:30`）；3.3.0 的 401 换凭据重试一次（`CHANGELOG.md:12`）对应 `bin/kimi-datasource.mjs:362`–`bin/kimi-datasource.mjs:368`。
- kimi-webbridge 的两个 md：daemon 实现不在本仓库内，只能核对仓内集成点，全部一致——默认地址 `127.0.0.1:10086`（`SKILL.md:11`、`operations.md:33` vs `packages/agent-core-v2/src/app/capability/entries/kimiWebbridge.ts:24`）、二进制路径 `~/.kimi-webbridge/bin/kimi-webbridge[.exe]`（`SKILL.md:162`、`operations.md:14` vs 同文件 53–55 行）、`start` 幂等（`operations.md:23` vs 同文件 212 行）、`/status` 字段 `running`/`version`/`extension_connected`（`operations.md:43`–`operations.md:48` vs 同文件 30–34 行）、版本号 2.0.11（`SKILL.md:6` vs `plugins/official/kimi-webbridge/kimi.plugin.json:4`）。
- `plugins/official/kimi-datasource/kimi.plugin.json:8` 的 `"command": "node"` 与 `bin/kimi-datasource.mjs:1` 的 `#!/usr/bin/env node`：宿主显式支持该形态——`packages/agent-core-v2/src/app/plugin/manager.ts:731`（Electron 分支）与 `packages/agent-core-v2/src/app/plugin/manager.ts:741`（原生二进制分支）把 `node` 改写为内置运行时（`__plugin_run_node`，常量在 `manager.ts:712`）或 Electron 的 `process.execPath`，且 `manager.ts:737` 的注释明确「a bare `bun` checkout … must not hijack stdio node plugins」，属设计契约，不报。
- `plugins/official/kimi-datasource/CHANGELOG.md:17`「Append a trace line (`request-id` / `tool-call-id`) to every tool result」：`bin/kimi-datasource.mjs:155`–`bin/kimi-datasource.mjs:160`（未知工具）与 `bin/kimi-datasource.mjs:257`（`toolCallId` 未设置时不追加）确实存在不追加 trace 行的返回路径，但这些路径都没有发出后端请求、本就无法与后端日志关联，判定不构成误导，未报告。
