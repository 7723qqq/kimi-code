# agent-core-v2 文档审计（features/{skill,cron,codeRuntime,lsp,notify,sessionInit,sessionQuery} + app 下的 .md）

范围：`packages/agent-core-v2/src/features/{skill,cron,codeRuntime,lsp,notify,sessionInit,sessionQuery}/**` 与 `packages/agent-core-v2/src/app/**` 下的全部 .md，逐份与实现比对。
说明：agent-core-v2 按策略是无注释区，Class 2 由另一项检查覆盖，本文件只报 Class 1 与 Class 3。

## 发现

- `packages/agent-core-v2/src/app/telemetry/cloudAppender.ts:180` — 类别 1 · 中 — 遥测上下文把运行时硬编码为 `runtime: 'node'`，同一对象字面量的 `:183` 又把 `process.versions.node` 当作运行时版本上报；仓库已迁移到 Bun，Bun 下 `process.versions.node` 返回的是 Bun 模拟的 Node 兼容版本而非实际运行时版本，`runtime` 也应为 `bun`。仓库别处已有可用的运行时判别（`packages/agent-core-v2/src/app/auth/webSearch/engines/http3.ts:75` 的 `isBunRuntime()`、`packages/agent-core-v2/src/_base/execEnv/environmentProbe.ts:22` 的 `'bun' | 'node'`），说明该字段本可正确取值。

- `packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/claude-3.5-sonnet.md:4` — 类别 3 · 高 — 文件头声称「Injected into system prompt when claude-3.5-sonnet is the active model」，但全仓库没有任何代码引用 `model-adaptations` 目录（`grep -rn "model-adaptations"` 排除 node_modules/dist 后零命中；`grep -rn "adaptation"` 在 `packages/agent-core-v2/src` 下只命中这三个 .md 自身）。系统提示实际由 `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts:12` 引入的 `system.md` 模板渲染，没有任何按模型注入适配文本的入口。同目录 `deepseek-v3.md:4`、`gpt-4o.md:4` 有完全相同的假断言。

- `packages/agent-core-v2/src/app/workflow/tools/workflow.md:53` — 类别 3 · 中 — 文档把 `opts.timeoutMs` 列为 `agent()` 的「per-agent timeout」，但 `packages/agent-core-v2/src/app/workflow/workflowRuntime.ts:276-328` 的 `spawnAgent` 从不读取 `opts.timeoutMs`（该文件里 `timeoutMs` 只出现在 exec hook 自己的 `:134`/`:140`），`AgentOpts.timeoutMs` 也只在 `packages/agent-core-v2/src/app/workflow/workflowTypes.ts:28` 声明、无任何消费点，传了等于没传。同一列表的 `workflow.md:52` 把 `opts.phase` 列为「phase tag」，同样从未被 `spawnAgent` 读取（内置脚本如 `packages/agent-core-v2/src/app/workflow/builtin/deep-research.js:145` 传入的 `phase` 被静默丢弃），当前阶段只由 `phase()` 原语经 `workflowRuntime.ts:91-94` 设置。

- `packages/agent-core-v2/src/app/memory/tools/memory.md:10` — 类别 3 · 中 — 文档写「### `search` (default)」，`packages/agent-core-v2/src/app/memory/tools/memoryTool.ts:28-29` 的字段描述也写「`search` is the default」；但 `MemoryToolInputSchema` 的 `action` 是必填的 `z.enum`（`memoryTool.ts:23-29`，既无 `.default()` 也无 `.optional()`），工具参数按 JSON Schema 校验（`packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts:806` → `packages/agent-core-v2/src/tool/args-validator.ts:91`），省略 `action` 会直接以「must have required property 'action'」被拒，不存在默认值。

- `packages/agent-core-v2/src/features/skill/catalog/builtin/check-kimi-code-docs.md:32` — 类别 3 · 中 — 页面表把 `kimi-code-cli/guides/goals.html` 列为 guides 章节的页面之一，实测该 URL 返回 404（同目录 `getting-started.html` / `sessions.html` / `interaction.html` / `ides.html` / `migration.html` / `use-cases.html` 均 200），仓库文档侧边栏 `docs/.vitepress/config.ts:153-164` 的 guides 分组里也没有 goals 页。skill 会让模型去 FetchURL 一个不存在的页面。

- `packages/agent-core-v2/src/features/skill/catalog/builtin/check-kimi-code-docs.md:35` — 类别 3 · 中 — 页面表把 `third-party-tools/other-coding-agents.html` 列为「Using Kimi Code in Claude Code and other third-party agents」的页面，实测该 URL 返回 404（同目录 `claude-code.html` / `codex.html` / `opencode.html` 均 200），该行指向的页面不存在。

- `packages/agent-core-v2/src/features/lsp/tools/lsp/lsp.md:16` — 类别 3 · 中 — 文档断言「The file must be inside the session workspace」，但 `packages/agent-core-v2/src/features/lsp/tools/lsp/lspTool.ts:40-48` 把 `args.file_path` 原样交给 `lsp.query`，`packages/agent-core-v2/src/features/lsp/lspInstance.ts:105-106` 直接 `hostFs.readText(request.filePath)`，而 `HostFileSystem.readText` 是裸 `readFile`（`packages/agent-core-v2/src/os/backends/host/hostFsService.ts:52-64`），全程没有任何 workspace 包含性检查；`LspTool.resolveExecution`（`lspTool.ts:27-58`）也未声明 `accesses`，因此不会走 `packages/agent-core-v2/src/tool/path-access.ts:328` 的 `outsideWorkspace` 判定。传 workspace 外的路径不会被拒绝。

## 已核对为真、不作为发现的项（避免误报）

- `cron-create.md` 的 50 条上限（`cron-create.ts:6`）、5 年无触发拒绝（`cronCreateTool.ts:63`）、jitter 参数 10%/15min/90s（`internal/jitter.ts:10-14`）、7 天 stale（`cronService.ts:51,123-132`）、envelope 字段（`internal/format.ts:18-32`）。
- `cron-list.md` 的 200 字节截断（`cronListTool.ts:15-23`）、`ageDays` 两位小数（`:88`）、空态文案（`:50`）、`---` 分隔与插入序（`:55`）、`nextFireAt` 带数字偏移（`internal/format.ts:3-16`）。
- `cron-delete.md` / `cron-list.md` 的「用户没有 `/cron` 命令」：`apps/kimi-code/src/tui/commands/registry.ts` 中确无 cron 命令。
- `run_code.md` 的 async 函数体、五个 console 方法、`invalid-output`、每次新 worker、软隔离（`codeWorkerSource.ts:22-127`、`codeExecutor.ts:43-59`）。
- `lsp.md` 的 1-based 位置（`lspTool.ts:44`）、`[lsp]` 配置示例与「无 provider 时报错并说明如何配置」（`lspService.ts:56-60`）。
- `session-query.md` 的 20 条上限（`sessionQueryTool.ts:30`）、字面量查询语义（`search.ts:44-52`）、`session_trace` 的祖先链+后代树（`toolPresentation.ts:65-75`）。
- `notify-user.md` 的面板行为（`apps/kimi-code/src/tui/components/chrome/notify-panel.ts:1-16`、`theme-selector.ts`）。
- `custom-theme.md` 的 19 个 token 与 `apps/kimi-code/src/tui/theme/colors.ts:17-80` 完全一致；`Custom: {{name}}` 标签（`en.ts:912`）、每次打开重扫目录（`theme-selector.ts:23`）、`Theme unchanged`（`commands/config.ts:743-746`）、base 默认 dark 与非法 hex 静默丢弃（`custom-theme-loader.ts:16-22,59-63`）。
- `mcp-config.md` 的 `[mcp] startup_timeout_ms` / `tool_timeout_ms`（TOML 键经 `app/config/toml.ts:9` 的 `snakeToCamel` 映射到 `McpSectionSchema`）、`packages/node-sdk/src/config/schema.ts:369,383` 的两个 schema、`1..2147483647` 超时范围、`KIMI_MCP_*` 环境变量。
- `update-config.md` 的 `kimi doctor config|tui <path>`（`apps/kimi-code/src/cli/sub/doctor.ts:87-99`）、`/reload` 与 `/reload-tui`（`tui/commands/registry.ts:392,401`）、`[loop_control] max_retries_per_step` 弃用与 `KIMI_LOOP_MAX_RETRIES_PER_STEP` 环境变量（`agent/loop/configSection.ts:11,52`）、`[secondary_model]` 的 `default_model`/`models`/`force` 与 `[subagent] timeout_ms`（`session/subagent/configSection.ts:23-30`）。
- `import-from-cc-codex.md` 的 `.kimi-code/mcp.json` 只读 cwd（`app/mcpConfig/configLoader.ts:30`）、项目根 `.mcp.json`（`:29`）、`$KIMI_CODE_HOME/skills/` 与 `.agents/skills`（`features/skill/catalog/skillRoots.ts:9-12`）、mcp-config 仅用户可调用（`builtin/mcp-config.ts:22` 显式 `disableModelInvocation: true`）。
- `write-goal.md` 的 `CreateGoal` 工具存在（`features/goal/tools/create-goal/createGoalTool.ts:19`）；`sub-skill/SKILL.md` 的 `has-sub-skill: true` 被解析（`features/skill/catalog/fileSkillDiscovery.ts:221-229`）。
- `system.md` 的 14 个 `${...}` 占位符全部由 `profile-shared.ts:159-193` 的 `systemPromptVars` 提供。

## 边界项（未计入发现，供参考）

- `write-goal.md:76,78` 的示例目标文本使用 `npm test`（仓库已迁到 Bun）。该 skill 面向任意用户项目、示例意在演示「proof」的形状而非本仓库工具链，判定为误报风险高于价值，故未列为 Class 1。
- `memory.md:3,24-26` 把路径写成 `~/.kimi-code/memory/...`，未提 `KIMI_CODE_HOME` 覆盖（`app/memory/memoryTool.ts:158` 用 `bootstrap.homeDir`，即 `resolveKimiHome` 的结果）。默认值正确，仅在设置了 `KIMI_CODE_HOME` 时不准，属不完整而非假断言，未计入。
