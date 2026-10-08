# agent-core-v2 审计 — src/human、src/agent/{contextMemory,fullCompaction,knowledge,permissionMode}、src/session、docs/{en,zh}、CHANGELOG

范围（全部通读并与实现比对）：
`packages/agent-core-v2/src/human/**`、`packages/agent-core-v2/src/agent/{contextMemory,fullCompaction,knowledge,permissionMode}/**`、
`packages/agent-core-v2/src/session/**`、`packages/agent-core-v2/docs/{en,zh}/**`、`packages/agent-core-v2/CHANGELOG.md`。

说明：agent-core-v2 按策略是无注释区（`DEVELOP.md:410`，`scripts/check-no-comments.mjs` 覆盖 `src/`/`test/`/`scripts/` 下的 `.ts`/`.mts`/`.mjs`），
因此本文件只报 Class 1 与 Class 3；Class 2 由另一项检查覆盖。范围内全部 `.md`（13 份）已逐份读完。

## 发现

- `packages/agent-core-v2/docs/en/llm.md:48` — 类别 3 · 中 — 说明：文档的架构树写「bases/ four protocol bases: openai / openai-responses / anthropic / google-genai」，实际 `bases/` 下有五个协议基座，`antigravity` 已是一等协议（`ProtocolName` 含 `'antigravity'`，`standard.ts` 注册了 `antigravityProvider`，`llm-adapter/protocol/protocol-base.ts` 也把它列入协议表）；同文件 `:3` 的协议枚举与 `:9` 的 trait 接口枚举（`OpenAITrait` / `OpenAIResponsesTrait` / `AnthropicTrait` / `GoogleGenAITrait`）同样漏掉 `AntigravityTrait`（依据：`packages/agent-core-v2/src/human/llm/protocol/base.ts:7-12`、`packages/agent-core-v2/src/human/llm/provider/providers/standard.ts:50-53`、`packages/agent-core-v2/src/human/llm/requester/bases/antigravity/requester.ts:1`）。同 `packages/agent-core-v2/docs/zh/llm.md:48`（「四个协议基座」）。

- `packages/agent-core-v2/docs/en/llm.md:77` — 类别 3 · 中 — 说明：文档在「Rejected Schemes」里断言协议拆分为 `anthropic` / `anthropic_beta`，并要求「a provider that needs beta features must use the `anthropic_beta` protocol explicitly」；代码里不存在该协议，`ProtocolName` 只有 openai / openai_responses / anthropic / google-genai / antigravity，全仓库除这两份文档外无 `anthropic_beta` 命中（依据：`packages/agent-core-v2/src/human/llm/protocol/base.ts:7-12`）。同 `packages/agent-core-v2/docs/zh/llm.md:77`。

- `packages/agent-core-v2/docs/en/event-name.md:27` — 类别 3 · 中 — 说明：文档把 `requestActor` 列为「被 invoke 的 actor」命名示例，但全仓库代码 0 处出现该名字；turn machine 实际 invoke 的请求 actor 叫 `llmActor`（依据：`packages/agent-core-v2/src/human/agent/turn.ts:378` 定义 `llmActor: createRequestActor(...)`、`:491` `src: 'llmActor'`）。同 `packages/agent-core-v2/docs/zh/event-name.md:27`。

- `packages/agent-core-v2/src/human/tool/wait-for.md:15` — 类别 3 · 中 — 说明：工具描述断言「A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification」，但 human 层实现里 background 任务完成时无条件追加完成通知，WaitFor 不做任何抑制；该描述对应的实现自己的测试断言两者同时出现（依据：`packages/agent-core-v2/src/human/agent/machine.ts:217` 的 `completionPatch` 无条件 `notifications: [...context.notifications, completionNotification(...)]`、`packages/agent-core-v2/src/human/test/agent/machine.test.ts:500` 测试名「lets WaitFor reap a completed background task and delivers the notification in the same batch」、`:541` 断言 `user:[async tool completed] bg_tool (tool_call_id=call-1)` 与 `tool:completed: call-1` 并存）。注：新引擎的 WaitFor（`src/agent/tools/task/task-wait/`，不在本次范围）有 `markTasksDeliveredViaWait` 去重（`src/agent/task/taskService.ts:605`），human 层这份没有。

## Class 1（Node 时代写法）— 无发现

范围内逐项扫描，均无命中或均属硬性排除项：

- `npm` / `yarn` / `pnpm` / `npx` 调用：范围内唯一命中是 `src/human/models-dev/models-dev.ts:35,42,127,134,159,287,326` 的 `npm` 字段——那是 models.dev 数据源的字段名（`@ai-sdk/openai` 之类的包名），不是包管理器调用。
- Node shebang、`.nvmrc`、`engines.node`、`package-lock.json`、`yarn.lock`、`.npmrc`、`packageManager`：范围内 0 命中（`packages/agent-core-v2/package.json` 无 `engines`/`packageManager`）。
- `process.versions.node`、硬编码 `runtime: 'node'`、`node --test` 派发：范围内 0 命中（`process.platform` 的用法 Bun 同样支持）。
- `node:` 内置导入：范围内共 30 处，只有 path / fs / fs/promises / crypto / stream / readline / os / child_process / buffer，Bun 全部实现（按任务要求，`node:` 前缀本身不报）。
- 原生插件加载器的 `require()`：`src/agent/knowledge/knowledgeService.ts:52` 的 `require('@moonshot-ai/kimi-native-tools')` 属硬性排除的「原生插件加载器」类别（与 `src/_base/native-tools.ts:19`、`src/tool/native-glob-match.ts:7` 同一模式），且 Bun 支持 N-API 加载，不报。

## 已核对为真、不作为发现的项（择要）

- `docs/en/llm.md` / `docs/zh/llm.md`：`LlmRequester.generate(config, content, control)` 与 `ExtraParams{openai?,responses?,anthropic?,googleGenai?}`（`requester.ts:33-37`、`:77-79`）、`credentialProvider` 的 resolve/canRecover/invalidate（`:47-51`）、`LlmInput.signal`（`actor.ts:15-19`）、`createStaticCredentialProvider`/`createOAuthCredentialProvider`/`createKimiOAuthCredentialProvider`、`runWithCredentialRecovery`/`streamWithCredentialRecovery`（`llm-adapter/model/credential-recovery.ts:3,17`）、`prepareOpenAIRequest` 等四个 `prepare*Request`、trait hook 顺序（`bases/openai/requester.ts:100-130`）、`ProviderDefinition`/`Provider` 形状（`provider/definition.ts:41-58`）、`createProvider` 无 registry、provider-catalog 的 refresh/upsert/remove/ping→changed（`provider-catalog.ts:89-100`）、`emptyResponseError` 由 turn 在 `llm.done` 转 `llm.failed.remote`（`human/agent/turn.ts:344,595`）、`credentialsRecovery` 先于替换消息策略（`agent/loop/machine/engine.ts:373`）、`llm.retrying`/`llm.recovering` 由 turn 补发（`human/agent/turn.ts:319-340`）、accumulator 只在 turn（`human/agent/turn.ts:109-122`）、`llm.streaming.*` 通配（`human/agent/machine.ts:896`、`human/session/machine.ts:94`）、`toolCallIdNormalizer` 去重语义、`format`/`trait` 互不 import（`bases/*/format.ts` 与 `bases/*/trait.ts` 互无引用）、bases 内部模块的 import 边界由 `packages/agent-core-v2/scripts/check-import-boundaries.mjs:40` 强制。
- `docs/en/event-name.md` / `docs/zh/event-name.md`：命令类事件 `input.submit`/`input.steer`/`input.abort`/`input.remind`/`tool.abort`/`turn.abort`/`turn.drain`/`turn.notify`/`turn.spawn_tools`/`context.reset`；事实类 `llm.sent`/`llm.done`/`llm.failed.syntax`/`llm.failed.remote`/`llm.retrying`/`llm.recovering`/`tool.done`/`tool.failed`/`tool.aborted`/`tool.detached`/`turn.reminders_consumed`/`todo.used`；emitted 类 `turn.started`/`step.started`/`turn.done`/`turn.failed`/`turn.aborted`/`turn.aborting`/`agent.created`/`agent.forked`/`agent.switched`/`agent.stopped`/`agent.failed`/`usage.updated`；数据流类 `llm.streaming.*`/`tool.update`/`usage.record`；命名空间 `cron.*`/`goal.*`/`reminder.*`/`dateChange.*`/`interaction.*`/`runtime.*`；状态 `idle`/`running`/`active`/`thinking`/`acting`/`draining`/`preparing`/`executing`/`finishing`/`succeeded`/`failed`/`aborted`；action `forwardToParent`/`spawnTurnTools`/`abortTurnTools`；actor `executeActor`/`preparingActor`/`finishingActor`/`cronEffects` —— 全部在代码中命中。
- `src/agent/knowledge/tools/knowledge-tool.md`：四个 action（`knowledge-tool.ts:13`）、`confirm` → confidence 1.0（`:94`）、`reject` 删除条目（`:102`）、每回合注入（`knowledgeInjection.ts:20-22` 的 `isNewTurn`）。
- `src/agent/fullCompaction/compaction-instruction.md:51,53`：恢复指针自动追加（`fullCompactionService.ts:867`）、TODO 列表自动重挂（`:845`）。
- `src/agent/fullCompaction/context-recovery-footer.md`：`context.append_message`/`context.append_loop_event`/`context.apply_compaction`/`context.undo`(count=N)/`context.clear` 记录类型（`contextEvents.ts:18,35,47,93,104`）、loop event 的 `step.begin|content.part|tool.call|tool.result|step.end`（`loopService.ts:1447,1517,1550,1596,1821`）、50k 字符阈值（`tool/toolContract.ts:7`）、`agents/<agentId>/wire.jsonl` 布局（`wire/record.ts:3`）。
- `src/agent/contextMemory/compaction-summary-prefix.md` 与 `src/human/compaction/compaction-summary-prefix.md`：用户消息按 head+tail 原样保留、中段由 `<system-reminder>` 省略说明标注（`human/compaction/shape.ts:39-51,89`、`agent/contextMemory/compactionHandoff.ts:148-161`）。
- `src/agent/permissionMode/injection/permission-mode-auto-enter-reminder.md:3`：auto 模式下 AskUserQuestion 被拒（`agent/permissionPolicy/permissionPolicyService.ts:35` 注册 `AutoModeAskUserQuestionDenyPermissionPolicyService`）；进入/退出提醒的注入时机（`permissionModeInjection.ts:40-51`）。
- `src/human/todo/todo-list.md`：`todos` 省略=查询、`[]`=清空、状态枚举 pending/in_progress/done（`human/todo/tool.ts:17-33,38,48`）。
- `src/session/agentLifecycle/profile/explore-overlay.md`：explore 无编辑工具（`profiles.ts:79-87` 的 `EXPLORE_TOOLS` 不含 Write/Edit）、`<git-context>` 块（`gitContext.ts:97`）。
- `packages/agent-core-v2/CHANGELOG.md`：0.4.3 的 `${now}` 已从模板变量表移除（`src/` 下 0 命中）；0.4.2 的 `isDisplayablePromptOrigin` 接受 `system_trigger/subagent`（`agent/loop/turnEvents.ts:95`）；0.4.1 的 400/300/3000 预算（`sessionTitleService.ts:32,34,40`）；0.4.0 的 `titleKind` 三值与「不覆盖用户改名」（`sessionMetadata.ts:15`、`sessionTitleService.ts:79-92`）、`session.meta.updated`（`sessionMetaEvents.ts:16`）；0.3.2 的 `archivedAt`/`archived_at`（`sessionMetadata.ts:26`、`app/sessionLegacy/sessionProtocol.ts:113`）；0.3.0 的 `clientIdentity` 与导出 manifest 的 `desktopVersion`（`app/bootstrap/bootstrap.ts:57`、`app/sessionExport/manifest.ts:21`）。

## 已考虑但未报告

- `packages/agent-core-v2/CHANGELOG.md:25`（0.4.0 条目）称会话标题「Gated by the new experimental `auto_session_title` flag」，该实验 flag 已随 #3749 毕业删除（`src/session/sessionTitle/` 下无 `flag.ts`，`src/` 内 `auto_session_title` 0 命中）。判为发布时的历史记录（同一条已在 `changelogs-packages.md` 就 `packages/kap-server/CHANGELOG.md:15` 报出），不重复计入。
- `docs/en/llm.md:15` 的「Patterns each rewrite a MessageRange into another MessageRange」：`MessageRange` 不是代码里的符号（`protocol/rewrite.ts:1-9` 是 `Rewrite<T>{consumed,replacement}` + `Pattern<T>`），但该句是对 N:M 重写语义的概念描述而非符号断言，不报。
- `docs/en/llm.md:60` 的 media 目录只列了 6 个贡献点（实际 12 个文件）：其余为内部辅助模块，属列举而非计数断言，不报。
- `src/human/tool/wait-for.md:8` 的「capped at 600」与 `src/agent/tools/task/task-wait/task-wait.md:11` 的「capped at 90」并存：两套 WaitFor 各自的常量确实分别是 600（`human/tool/wait-for.ts:5`）与 90（`agent/tools/task/task-wait/task-wait.ts:6`），各自自洽，不报。
