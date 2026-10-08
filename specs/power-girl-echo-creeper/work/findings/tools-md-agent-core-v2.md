# `packages/agent-core-v2/src/agent/tools/**` 下的工具描述 .md 审计

范围：`packages/agent-core-v2/src/agent/tools/**` 下全部 19 个 .md（agent、ask-user-question、edit、fetch-url、os/{bash,glob,grep,read,write}、task/{task-list,task-output,task-stop,task-wait}、team、web-search）。这些是工具描述，属「提示词即行为」，逐份与对应实现比对参数名、默认值、行为声明。只读审计，未修改任何仓库文件。

方法：先通读全部 .md 提取可验证断言，再定位对应实现（schema、handler、默认值常量、格式化函数、通知构造），对可疑项用 `git log`/`git show` 追代码与文档的改动时序，并用仓库自带测试作为行为证据。

**去重说明**：同目录其他 findings 文件均未覆盖本范围——`docs-agent-core-v2.md` 覆盖 `features/{skill,cron,codeRuntime,lsp,notify,sessionInit,sessionQuery}` 与 `app/**`，`feature-prompts.md` 覆盖 `features/{plan,spec,goal,todo,swarm,tower}`，`node-era-pass1.md` 覆盖全仓 require/npm 命中点。本文件只列 `agent/tools/**` 的 .md。

**计数**：2 条（高 0 / 中 2 / 低 0）。另有 6 条候选经核实后判定为误报或过弱，见文末「边界项」。

---

## 发现

- `packages/agent-core-v2/src/agent/tools/agent/agent-background-enabled.md:1` — 类别 3 · 中 — 说明：文档声称后台子代理的完成通知是「a synthetic user-role message containing its result」，即消息里带着子代理的结果；代码实际只投递一个指向输出文件的**指针**，结果本身被刻意排除在消息之外。`agentTaskNotificationChildren` 在 `fullOutputAvailable` 时返回 `renderOutputFileBlock`，其正文是「Read the output file to retrieve the result: <path>」（依据：`packages/agent-core-v2/src/agent/task/taskService.ts:1417-1418`、`packages/agent-core-v2/src/agent/task/taskService.ts:1468-1474`），仓库测试直接断言结果不在通知里（依据：`packages/agent-core-v2/test/agent/task/rpc-events.test.ts:503-504` 的 `expect(text).toContain('<output-file')` 与 `expect(text).not.toContain('final subagent summary')`）。这不是边缘路径：后台子代理任务的输出必然落盘（`outputPersistStarted: detached`，依据：`packages/agent-core-v2/src/agent/task/taskService.ts:347`），且 `notificationOutputSnapshot` 对 `kind !== 'question'` 一律先取 `fullOutputAvailable` 的快照（依据：`packages/agent-core-v2/src/agent/task/taskService.ts:1301-1308`），所以「消息含结果」在常态下恒为假。对照：同一批描述里 `os/bash/bash.md:16` 只写「You will be automatically notified when the task completes.」，`ask-user-question/ask-user-question.ts:52` 只写「The answer arrives automatically in a later turn」，都没有做「消息含结果」这个断言。

- `packages/agent-core-v2/src/agent/tools/team/team.md:80` — 类别 3 · 中 — 说明：文档声称讨论模式的结果包含「aggregate token usage」，但 `formatDiscussionResult` 只输出 `<summary>rounds/speeches/status</summary>`、`<transcript>` 与 `<final_summary>`，从不渲染 `DiscussionResult.usage`（依据：`packages/agent-core-v2/src/agent/tools/team/teamTool.ts:137-163`）。该字段确实被计算出来（依据：`packages/agent-core-v2/src/agent/team/coordinator.ts:44-45` 的 `readonly usage: TokenUsage`、`packages/agent-core-v2/src/agent/team/coordinator.ts:141` 的 `const usage = this.collectUsage();`），只是被格式化函数丢弃。对照：同一份文档的辩论模式一节（`team.md:89`）没有做这个断言，`formatDebateResult` 也确实不含 usage（依据：`packages/agent-core-v2/src/agent/tools/team/teamTool.ts:165-203`），说明这是讨论模式独有的漏更新。

---

## 已核对为真、不作为发现的项（避免误报）

### agent / agent-background / agent-fork

- `agent.md:1`「same-process loop instance with its own context and wire file」：子代理经 `agentLifecycle.create` / `fork` 在进程内创建（`packages/agent-core-v2/src/session/subagent/subagentService.ts:153-181`），wire 文件按 agent 分目录（`packages/agent-core-v2/src/human/persist/v2/migrate.ts:57` 的 `join(agentsDir, name, 'wire.jsonl')`）。外部后端（ACP / Claude Code / Codex）虽存在（`packages/agent-core-v2/src/session/subagent/backend/`），但 `backendIncompatibility` 与 `stripSubagentBackendParameter` 全仓无调用点，`agent.ts` 的 schema 也没有 `backend` 字段，该路径未接线，不影响本断言。
- `agent.md:10` 的 `resume` 参数名、`agent-background-disabled.md:1`「any call that sets it is rejected before the subagent launches」：拒绝发生在 `this.launch(...)` 之前（`packages/agent-core-v2/src/agent/tools/agent/agentTool.ts:446-449` vs `:462`）。
- `agent-fork.md:1` 的三条断言（非空 `resume` 与 `fork` 互斥、`subagent_type` 必须等于自身类型、`model` 必须是自身别名或 `primary`）与 `forkIncompatibility` 逐条对应（`packages/agent-core-v2/src/session/subagent/spawn.ts:22-45`）。
- `agent.ts:36` 的「Defaults to "coder" when omitted」：即使 `z.preprocess` 在运行时从不执行（`SubagentToolInputSchema` 只被 `toInputJsonSchema` 用于生成 JSON Schema，见 `packages/agent-core-v2/src/agent/tools/agent/agentTool.ts:90`），`planSpawn` 自身也会回落到 `DEFAULT_PROFILE_NAME`（`packages/agent-core-v2/src/session/subagent/subagentService.ts:99-100`），断言仍成立。

### os/bash

- `bash.md:1` 的 `${SHELL_NAME}`、`:16` 的 `${DEFAULT_BACKGROUND_TIMEOUT_S}`=600s / `${MAX_BACKGROUND_TIMEOUT_S}`=86400s、`:20` 的 `${DEFAULT_TIMEOUT_S}`=60s / `${MAX_TIMEOUT_S}`=300s：与 `packages/agent-core-v2/src/agent/tools/os/bash/bash.ts:6-9` 一致，占位符由 `renderPrompt` 注入（`packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:62-64`）。
- `bash.md:14`「the output ends with a `Command failed with exit code: N` line」：`ToolOutputAccumulator.error` 把消息追加在缓冲输出之后（`packages/agent-core-v2/src/tool/output-accumulator.ts:53-68`），调用点 `packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:351`。
- `bash.md:16`「you must provide a short `description`」：`packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:314-319`。
- `bash.md:16`「point them to the background-task panel」：面板存在（`apps/kimi-code/src/tui/components/dialogs/tasks-browser.ts`）。
- `bash.md:20`「moved to the background instead of being killed」：默认 `autoBackgroundOnTimeout` 为真（`packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:115-117`），关闭时描述会被 `withoutAutoBackgroundOnTimeout` 改写（`:86-91`）。
- `bash.md:19`「fresh shell environment」：每次 `spawn(env.shellPath, ['-c', ...])`（`packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:171`）。

### os/glob、os/grep

- `glob.md:1`「sorted by modification time (most recent first)」：`--sortr=modified`（`packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts:371`）。
- `glob.md:3` 的 `.gitignore`/`.ignore`/`.rgignore` 默认生效、`include_ignored` 关闭之、敏感文件始终过滤、只列文件：`--files --hidden` + `--no-ignore` 条件分支 + 恒定的 `SENSITIVE_GLOBS_TO_EXCLUDE` 与 `isSensitiveFile` 过滤（`packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts:368-382`、`:242-250`）。
- `glob.md:13` 的 100 / offset 0 / `head_limit=0` 去上限 / 大页存文件：`packages/agent-core-v2/src/agent/tools/os/glob/glob.ts:46`、`packages/agent-core-v2/src/agent/tools/os/glob/globTool.ts:252-254`、`:323-329`；存文件走通用 spill（`packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts:67-70`，阈值 `DEFAULT_TOOL_RESULT_MAX_CHARS = 50_000` 而 glob 的保留上限是 `DEFAULT_TOOL_RESULT_MAX_RETAINED_CHARS = 10_000_000`，见 `packages/agent-core-v2/src/tool/toolContract.ts:7,9`）。
- `grep.md:9`「Hidden files … are searched by default」：`--hidden` 恒定开启（`packages/agent-core-v2/src/agent/tools/os/grep/grepTool.ts:429`）。
- `grep.md:9`「Sensitive files … always skipped … even when `include_ignored` is `true`」：`SENSITIVE_GLOBS_TO_EXCLUDE` 与 `isSensitiveFile` 过滤都在 `--no-ignore` 之外独立生效（`packages/agent-core-v2/src/agent/tools/os/grep/grepTool.ts:462-465`、`:657`）。
- `grep.md:3`「this tool applies workspace path policy」：`resolvePathAccessPath` 带 `guardMode: 'absolute-outside-allowed'`（`packages/agent-core-v2/src/agent/tools/os/grep/grepTool.ts:91-96`）。
- `grep.md:7`「braces are special, so escape them as `\{`」：ripgrep 默认 Rust regex 语义，成立。

### os/read、os/write、edit

- `read.md:10` 的 `${DEFAULT_MAX_CHARS}`=100000 / `${MAX_CHARS}`=500000：`packages/agent-core-v2/src/agent/tools/os/read/read.ts:6-7`、`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:206-213`。
- `read.md:10`「Read results are not spilled or shortened again by the general tool-output limit」：`spillExempt: true`（`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:273`、`:291`）。
- `read.md:13-14` 的行内片段与 `column_offset` 语义（含越界与代理对报错、仅前向读支持）：`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:223-229`、`:470-486`、`:600-611`。
- `read.md:16` 的豁免名单 `.env.example` / `.env.sample` / `.env.template` 与 `id_rsa.pub`：`packages/agent-core-v2/src/tool/path-access.ts:29`、`:32`。
- `read.md:17` 的 UTF-16 LE/BE（含无 BOM）自动识别、严格解码优先、U+FFFD 有损告警、其他编码与 NUL 字节拒绝：`packages/agent-core-v2/src/_base/text/encoding.ts:23-62`、`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:341-374`、`:431-433`。
- `read.md:18` 的负 `line_offset` 尾读语义（超出预算时先返回最新的完整行、无完整行时给出前向 Next Read）：`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:637-710`、`:613-631`。
- `read.md:19` 的 `${MAX_MEDIA_MEGABYTES}`=100MB 与「region/full_resolution 仅图片、line_offset/n_lines 仅文本」：`packages/agent-core-v2/src/agent/tools/read-media-file/read-media-file.ts:4`、`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:318-339`。
- `read.md:20-21` 的降采样提示、`<system>` 块报告原始尺寸、压缩失败即报错且不发原图：`packages/agent-core-v2/src/agent/tools/read-media-file/execute-media-read.ts:61-113`、`:115-150`、`:273-283`。
- `read.md:22-25` 的输出格式、`<system>` 状态块内容、纯 CRLF 显示为 LF 且 Edit 回写 CRLF、混合换行显示为 `\r`：`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:123-131`、`:521-534`、`packages/agent-core-v2/src/_base/text/line-endings.ts:32-47`。
- `read.md:3` 的 `kimi-file://` 引用与「Next Read keeps the reference」：`packages/agent-core-v2/src/agent/media/mediaRef.ts:105-125`、`packages/agent-core-v2/src/agent/tools/os/read/readTool.ts:552-559`。
- `write.md:3-4,9-10` 的自动建父目录、mode 默认 overwrite、append 不加换行、忽略 Read/Edit 行号视图、逐字输出换行：`packages/agent-core-v2/src/agent/tools/os/write/writeTool.ts:89-98`、`:114-137`。
- `edit.md:7`「`old_string` must be unique unless `replace_all` is set」：`packages/agent-core-v2/src/app/edit/editService.ts:28-39`。
- `edit.md:11`「A write lock serializes same-file edits in response order」：`ToolScheduler` 对访问冲突的任务排队并按 FIFO 启动（`packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts:35-49`、`:76-86`），冲突判定含同路径写（`packages/agent-core-v2/src/tool/toolContract.ts:184-226`）。
- `edit.md:12-13` 的 CRLF 回写与混合换行 `\r` 转义：`packages/agent-core-v2/src/_base/text/line-endings.ts:32-51`。

### ask-user-question、fetch-url、web-search

- `ask-user.md:14`「Users always have an "Other" option」：TUI 合成该选项（`apps/kimi-code/src/tui/components/dialogs/question-dialog.ts:105-108`）。
- `ask-user.md:17,19` 的 2-4 选项与 1-4 问题、`:18` 的唯一性校验、`:21` 的 `answers`/`note` 结果形状：`packages/agent-core-v2/src/agent/tools/ask-user-question/ask-user-question.ts:20-26`、`:72-78`、`:49-70`，`packages/agent-core-v2/src/agent/tools/ask-user-question/askUserQuestionTool.ts:190`、`:266-274`。
- `fetch-url.md:1`「a note at the top of the result states which of the two you received」：`packages/agent-core-v2/src/agent/tools/fetch-url/fetchUrlTool.ts:62-68`。
- `fetch-url.md:3` 的仅 http(s)、拒绝私有/回环地址、超大页面拒绝：`packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts:302-308`、`:313-350`、`:110-117`。
- `web-search.md:3` 的 title/URL/snippet + site/date：`packages/agent-core-v2/src/agent/tools/web-search/webSearchTool.ts:64-68`。

### task/*

- `task-list.md:5-7` 的字段清单（task_id/status/description + command/pid/exit_code + stop_reason）：`formatTaskRecord` → `formatPlainObject` 输出 `ProcessTaskInfo` 的全部非空字段（`packages/agent-core-v2/src/agent/tools/os/bash/process-task.ts:14-20`、`packages/agent-core-v2/src/agent/task/tools/format.ts:11-24`）。
- `task-list.md:14-20` 的 `active_only` 默认 true、`limit` 1-100 默认 20、`active_only=false` 时含 `lost`：`packages/agent-core-v2/src/agent/tools/task/task-list/task-list.ts:6-20`、`packages/agent-core-v2/src/agent/task/taskService.ts:487-503`、`:1487-1491`。
- `task-output.md:10` 的 `status: completed` / `status: failed` + `exit_code`、`terminal_reason` 三值与「干净退出两者皆无」：`packages/agent-core-v2/src/agent/tools/os/bash/process-task.ts:69-71`、`packages/agent-core-v2/src/agent/tools/task/task-output/taskOutputTool.ts:21-26`。
- `task-output.md:9` 的 32KB 预览与 output_path：`packages/agent-core-v2/src/agent/tools/task/task-output/taskOutputTool.ts:13`、`:69-84`。
- `task-stop.md:12-13`「If the task has already finished, this tool simply returns its current status」：`packages/agent-core-v2/src/agent/tools/task/task-stop/taskStopTool.ts:37-46`。
- `task-wait.md:11` 的 timeout 必填且上限 90：`packages/agent-core-v2/src/agent/tools/task/task-wait/task-wait.ts:6-16`。
- `task-wait.md:13-16` 的「无 task_id 时任一在跑任务完成即返回」「有 task_id 时未知 id 报错、已完成立即返回」「无任务立即返回」「同时列出等待窗口内完成的其他任务」：`packages/agent-core-v2/src/agent/tools/task/task-wait/taskWaitTool.ts:170-192`、`:273-297`、`:299-310`、`:349-379`。
- `task-wait.md:17`「Waiting has no side effects on the waited tasks」：`wait` 只挂 waiter 与超时，不触碰任务本身（`packages/agent-core-v2/src/agent/task/taskService.ts:838-879`）。
- `task-wait.md:18`「delivered exactly once」：`markTasksDeliveredViaWait`（`packages/agent-core-v2/src/agent/tools/task/task-wait/taskWaitTool.ts:241-243`）。
- `task-wait-subagent.md:2` 的子代理变体确实被拼进描述（`packages/agent-core-v2/src/agent/tools/task/task-wait/taskWaitTool.ts:140-142`）。

### team

- `team.md:11,16,19,21` 的 `mode` 默认 `discussion`、`profileName` 默认 `coder`、`maxRounds` 讨论 3 / 辩论 2、`enableVoting` 默认 false：`packages/agent-core-v2/src/agent/tools/team/team.ts:12,28,43,55`，`packages/agent-core-v2/src/agent/tools/team/teamTool.ts:88,113,115`。注意工具参数按 JSON Schema 经 AJV 校验（`packages/agent-core-v2/src/agent/toolExecutor/toolExecutorService.ts:806` → `packages/agent-core-v2/src/tool/args-validator.ts:91`），AJV 未开 `useDefaults`，故 zod 的 `.default(3)` 不会在运行时填充，`?? 2` 的辩论分支确实生效——文档正确。
- `team.md:77-79` 的「每人发言前收到完整 transcript」「自然发言」「讨论在 maxRounds 轮后结束」：`packages/agent-core-v2/src/agent/team/coordinator.ts:114-118`、`:103-134`。
- `team.md:83-88` 的四阶段、交叉引用自动检测、立场变化跟踪：`packages/agent-core-v2/src/agent/team/debate-coordinator.ts:101-192`、`packages/agent-core-v2/src/agent/team/context.ts:163-210`。
- `team.md:89` 的 transcript / phase breakdown / consensus / cross_refs / position_changes：`packages/agent-core-v2/src/agent/tools/team/teamTool.ts:165-203`。

---

## 边界项（未计入发现，供复核）

- `os/bash/bash.md:27`（`npm install && npm test` 示例）与 `:44`（工具链列表含 `node`/`npm`/`pnpm`/`yarn` 而无 `bun`）：同目录 `node-era-pass1.md` 已就这两行明确判定为「通用示例（『use whichever the project actually relies on』），不报」。我独立复核后同意：两行都是对 `&&` 语义与常见命令类别的举例，未对本仓工具链做断言，不构成假断言。
- `agent/agent.md:4`「The subagent starts with zero context」与 `agent/agent-fork.md:1`「starts with a snapshot of your completed history instead of zero context」在同一份工具描述里并存（fork 开关打开时两段会同时拼进描述，见 `packages/agent-core-v2/src/agent/tools/agent/agentTool.ts:147-150`）。fork 段落显式写了「instead of zero context」，读者可自行消解，属自相矛盾而非单侧假断言，未计入。
- `task/task-list/task-list.md:6-7`「a stop reason for any task that ended early」：超时任务不带 `stop_reason`——`settleTask` 只在 `killed` 时保留既有 `stopReason`（`packages/agent-core-v2/src/agent/task/taskService.ts:1040-1041`），而 `timed_out` 的结算不传 `stopReason`（`packages/agent-core-v2/src/agent/task/taskService.ts:673-676`）。「ended early」措辞含糊（可读作「被停止/杀死」而非「超时」），未计入。
- `task/task-output/task-output.md:9,11`「an output_path for the full log」/「always available at output_path」：前台任务若输出不足 50,000 字符且从未转后台，`outputPersistStarted` 保持 false，结算时 `pendingOutput` 被直接丢弃、不落盘（`packages/agent-core-v2/src/agent/task/taskService.ts:1054-1060`），此时 `fullOutputAvailable: false` 且无 `outputPath`。但文档把 TaskOutput 的适用场景限定在后台任务（`task-output.md:3`），而后台任务必然落盘（`packages/agent-core-v2/src/agent/task/taskService.ts:347`），在文档自述的范围内断言成立，未计入。
- `os/read/read.md:20`「call Read again with the `region` parameter … to view a crop at full fidelity」：region 裁剪在超出尺寸预算时仍会被降采样，`skipResize` 仅在 `full_resolution=true` 时为真（`packages/agent-core-v2/src/agent/tools/read-media-file/execute-media-read.ts:311-312`），且代码自己的提示会写明「downsampled to WxH pixels」。同句已给出 `full_resolution` 作为补充手段，属不完整而非假断言，未计入。
- `edit/edit.md:9`「Multiple Edit calls may run in one response only when they do not target the same file」：同文件多 Edit 实际会被 `ToolScheduler` 串行执行而非拒绝（`packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts:35-49`），`edit.md:11` 也承认串行化会发生。该行是给模型的规则而非对执行的断言，未计入。
