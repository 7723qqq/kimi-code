# kimi-agent (Rust 原生引擎) 替代 v2 战略路线图与全量子系统技术对齐矩阵

> **战略总目标**：**彻底删除 `packages/agent-core-v2`（下称 v2）**。
> 
> 本路线图唯一的终态判定标准是：**v2 从 Monorepo 中物理消失，且 `apps/kimi-code`、`packages/kap-server` 与 `packages/klient` 完全由 Rust 原生引擎驱动**。
> 功能等效只是迁移期的过渡验收手段，不是终点。

> **铁律：Rust agent 是移植，未经允许禁止自创实现。**
> `packages/kimi-agent` 重实现既有行为，不是设计面：每一处行为都必须能指回参考实现，
> 或指回用户明示的裁决；否则就是缺陷，不是设计选择。
> **参考面有两条轴，不可混淆：v1 / v3 是通讯协议版本，v2 是引擎包（`agent-core-v2`）。**
> **引擎行为 → v2**（`agent-core-v2`）：本包重实现的引擎内部（turn 循环、工具执行、
> LLM wire 传输、权限、压缩、注入），即下文 Verification Standard 的
> "v2 is the behavioral reference" 适用处。
> **协议 v1** = REST `/api/v1`（`routes/`，前缀见 `registerApiV1Routes.ts`）+ WebSocket
> `/api/v1/ws`（`WS_PATH`，`transport/ws/v1/registerWsV1.ts`），传输层在
> `transport/ws/v1/`（`sessionEventBroadcaster`/`sessionEventJournal`/`wsConnectionV1`/
> `inFlightTurnTracker`/`subagentRosterTracker`）；其 op 与实体类型来自 `packages/transcript`，
> 事件→op 折叠在 `services/transcript/`（`coreEventMap.ts`、`transcriptService.ts`）。
> **协议 v3** = **已废弃（两侧同时）**。上游在 2.0.2（`2502d2157`，revert `64505e36e`，
> 后者随 0.43.0 引入）整体撤掉；fork 跟随于 §8.11（`86f30ecc2c`）。
> `/api/v3/ws`、分页 history 路由、`server/v3/`、`packages/protocol/src/v3.ts` 均已删除，
> kimi-inspect 改读 `/api/v1/ws` 的 `transcript.reset` / `transcript.ops`。
> **v1 是现存唯一协议轴**——未经用户许可不得再引入第二套。

---

## 1. 全架构 10 大子系统技术深度对齐矩阵（TS 源码 vs Rust 引擎）

本矩阵从零系统性复盘 GitHub 上 TypeScript 核心源码（覆盖 `agent-core-v2`（1,544 个文件）、`kap-server`（314 个文件）、`klient`（94 个文件）、`acp-server`（49 个文件）、`kosong`（41 个文件）、`transcript`（25 个文件）、`minidb`（58 个文件）等全仓 1,400+ 个 TS 源文件），对标 Rust 引擎（`packages/kimi-agent`，含 `src/native/` 原生工具层）的实现深度（文件数于 2026-09-15 按 `upstream/main` 实际统计复核）：

### 板块 1：核心 Turn 循环与生命周期管理

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **Turn 主循环驱动** | `agent-core-v2/src/agent/loop/loopService.ts`<br>`stepRequestQueue.ts` | `kimi-agent/src/turn_loop/run_turn.rs`<br>`src/turn_loop/turn_step.rs` | ✅ **100% 原生** | Rust 具备完全自主的 step 循环驱动，单轮支持最大步数约束（None = unbounded 镜像 JS）、TokenUsage 5 维细分累计、`finish_reason` 映射（length/max_tokens → MaxTokens、content_filter → Filtered）。（2026-09-19 更正：原先引用的 `check:engine-zero-js-loop` 门禁随 agent-core-v2 退役一并删除，现役门禁是 `scripts/check-no-legacy-engine.mjs`，只扫退役包引用、不做函数计数；「11 个函数零调用」已无活体验证。） |
| **并发工具调度** | `agent-core-v2/src/agent/toolExecutor/toolExecutor.ts` | `kimi-agent/src/turn_loop/tool_scheduler.rs` | ✅ **100% 原生** | 基于 `infer_tool_accesses` 静态推断资源冲突，构建并发批次。写写冲突、写读冲突严格串行化，只读工具并发放行；Bash 推断为全资源独占（`all_access()`，与 v2 未声明兜底一致），`write_tree_access("/")` 只用于 tower merge/teardown。 |
| **故障退避与重试** | `agent-core-v2/src/_base/utils/retry.ts` | `kimi-agent/src/turn_loop/retry.rs` | ✅ **100% 原生** | 指数退避，基数 500ms、上限 32,000ms，抖动为**单侧** `+[0, 25%]`（对齐 v2 `retryBackoffDelay`：`base + Math.random() * 0.25 * base`；v2 无下限）。错误分类对齐 v2 `isRetryableGenerateError`：可重试集 {408, 409, 429, 500..=599}（Rust 额外含 425），429 配额/欠费文案豁免（kimi-errors.ts 判据）；重试次数可经 `RunTurnInput.max_attempts` 配置，默认 10 对齐 v2 `DEFAULT_MAX_RETRY_ATTEMPTS`。 |
| **后台异步任务** | `agent-core-v2/src/agent/loop/nativeBackgroundAgentTask.ts` | `kimi-agent/src/storage/task_runner.rs` | ✅ **100% 原生** | 原生 `tokio::spawn` 托管后台任务，生命周期状态机为 Running/Completed/Killed（非 v2 的 Pending/Running/Completed/Failed），支持协作取消与 5s 宽限。后台 bash/子代理任务全部经 TaskRunner 注册（TaskStop/TaskOutput 全覆盖），并携带父 session 与任务类型向对应 WebSocket lane 广播 `event.task.created/completed` 与 `background.task.started/terminated` 双词汇生命周期事件。 |

### 板块 2：多 Provider LLM 抽象与流式传输

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **OpenAI 兼容协议** | `packages/kosong/src/providers/openai/`<br>`openai-legacy.ts` | `kimi-agent/src/llm/openai.rs`<br>`src/llm/wire.rs` | ✅ **100% 原生** | Chat Completions SSE 流式解析、原生 Tool Calls 增量合并、自定义请求头（customHeaders）、`reasoning_effort` 结构化透传、Audio/Video 媒体块原生编码。 |
| **OpenAI Responses** | `packages/kosong/src/providers/openai/openai-responses.ts` | `kimi-agent/src/llm/openai_responses.rs` | ✅ **100% 原生** | 对齐 OpenAI Responses 协议的请求投影与流式 Delta/failed/error 事件解析。两侧均无服务端会话状态追踪（TS 侧 store:false、无 previous_response_id），Rust 亦未请求 `include: reasoning.encrypted_content`。 |
| **Anthropic Messages** | `packages/kosong/src/providers/anthropic/` | `kimi-agent/src/llm/anthropic.rs` | ✅ **100% 原生** | 实现 Anthropic 提示词缓存断点注入（`cache_control: {"type": "ephemeral"}`）。上游 kosong 注 3 处断点（system / 尾块 / 末工具）；Rust 侧第 4 处 stable-history 断点是 fork 自加（上游无 `anthropic-cache-breakpoints.ts`，该文件是 fork 在 kosong 中所建、已删）。支持 `thinking.budget_tokens` 与思考块提取，自动恢复上下文溢出。 |
| **Google GenAI** | `packages/kosong/src/providers/google-genai/` | `kimi-agent/src/llm/google_genai.rs` | ✅ **100% 原生** | 原生 Gemini REST/SSE 协议，支持多模态 Part（inlineData 图片、fileData/fileUri URL 媒体、audio/video Part，mime 按扩展名推断）与 Function Calling（含工具名回查与 `thoughtSignature` 往返恢复）。SafetySettings 两侧均未实现。 |
| **MultiLLM 竞速降级**| `packages/kosong/src/pure/generate.ts` | `kimi-agent/src/llm/multi.rs` | ✅ **100% 原生** | 支持多个 Provider 并发 First-past-the-post 竞速，锁定粒度是整个响应完成（非首包），竞速期间无 delta 流出；败者经 child CancellationToken 中断原生 HTTP 通道并回收，全失败合并错误。注：TS kosong 侧并无竞速实现（竞速是本 fork 的 Rust 端能力）。 |

> **本表的「TypeScript 源码」列是上游原型的历史出处，不是本仓的活路径。**
> 板块 2 列出的 `packages/kosong/src/providers/*` 中的 wire 适配器栈已随 TS provider 栈一并删除
> （`createProvider` 与各 wire 适配器零生产消费者，wire 层由 `kimi-agent/src/llm/` 独占）。
> **2026-09-15 更正**：该目录并未整体消失——`providers/anthropic-profile.ts` 与
> `providers/astron-models.ts` 仍在，且是**活代码**（`packages/node-sdk/src/model-alias.ts`、
> `packages/oauth/src/open-platform.ts`、`packages/kosong/src/index.ts` 与
> `kosong/tsdown.config.ts` 均引用它们）：它们是共享的模型元数据，不是 wire 适配器。
> 板块 3 列出的 `agent-core-v2/*` 更早已物理删除。保留这些路径只为标明行为来源。

### 板块 3：原生基础工具链与沙箱执行网关

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **文件读写与修改** | `agent-core-v2/src/agent/tools/os/`<br>`read/`, `write/`, `edit/` | `kimi-agent/src/tools/mod.rs`（活体 Read）<br>`src/native/read.rs`（napi 历史接口） | ✅ **100% 原生** | 活体 Read 在 `src/tools/mod.rs:1813-2190`：行范围（`line_offset`/`n_lines`，上限 1000 行）、行截断（2000 字符）、`max_chars`（默认 100k / 上限 500k）与 `column_offset` 断点续读（#3645 实现在此，不在 `native/read.rs`）、编码侦测与媒体回退。与 v2 的差异：v2 无行数/行截断上限（只有字符预算 + 行分片续读）。Write：支持 append/overwrite 与原子写入；Edit：严格唯一匹配断言与 replace_all 模式。 |
| **文件搜索与模式匹配**| `agent-core-v2/src/agent/tools/os/`<br>`grep/`, `glob/` | `kimi-agent/src/tools/mod.rs`（Grep/Glob 工具）<br>`src/native/grep.rs`（napi 历史接口） | ✅ **100% 原生** | Grep：`regex` 引擎逐行扫描（非 ripgrep 子进程），开启 `--hidden` 等价行为并移植 `isSensitiveFile` 敏感文件过滤与脱敏提示；活体实现的 multiline 走整文件缓冲（`tools/mod.rs:2337-2341`）。`src/native/grep.rs` 的 napi 接口无仓内 TS 消费者。Glob：基于 `ignore`/`globset` 遵循 `.gitignore`，目录折叠。**2026-09-15 更正路径，2026-09-19 复核行数**：`Glob` 工具的定义与派发在 `src/tools/core_tool_defs.rs` / `src/tools/mod.rs`，而 `src/native/glob.rs`（61 行）只是 MCP 工具名过滤与权限模式匹配用的 `glob_matches_any` 辅助，不是该工具的实现。 |
| **命令执行与环境** | `agent-core-v2/src/agent/tools/os/bash/`<br>`packages/kaos/` | `kimi-agent/src/native/bash_spawn.rs`<br>`kimi-agent/src/tools/kaos.rs` | ✅ **100% 原生** | 原生执行平台 Bash（Windows 优先定位 MSYS2/Git Bash，拒绝 cmd），支持超时强制 Kill（默认 60s/上限 300s）、输出截断（`BASH_MAX_OUTPUT_BYTES = 256KB`，`tools/mod.rs:134`）、非零退出码精确传播、实时输出流向 `tool.progress` 广播。**2026-09-15 更正路径，2026-09-19 复核行数**：真正的一次性命令执行在 `src/native/bash_spawn.rs`（673 行）；`src/native/bash.rs`（41 行）只保留超时常量与 `kill_process_tree`。 |
| **沙箱隔离策略网关** | 无上游对应物（fork 自研） | `kimi-agent/src/tools/sandbox.rs` | ✅ **fork 自研** | P155 SandboxGuard：支持 Off / ReadOnly / WorkspaceWrite。规范化 Windows 盘符大小写不敏感匹配，越界写操作与命令执行 Fail-Closed 拦截，只读操作安全放行。**2026-09-19 更正出处**：引用的 `agent-core-v2/src/workspace/sandbox/sandbox.ts` 从未存在于上游，是 fork 在自有 v2 中新增（f007fc9f71）后随 v2 一并退役——本模块是 fork 原创，不是 v2 移植。 |

### 板块 4：权限决策引擎与 G-6 否决链全量收敛

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **权限决策模型** | `agent-core-v2/src/workspace/permission/`<br>`permissionGateService.ts` | `kimi-agent/src/permission/mod.rs`<br>`src/callbacks.rs` | ✅ **100% 原生** | 完备实现 Manual / Auto / Yolo 三大模式及完整策略链求值，支持独立运行本地判定与宿主双向委托（Fail-Closed 兜底，绝不发生二次弹窗）。 |
| **G-6 #1: Plan 文件保护**| `agent-core-v2/src/features/plan/` | `kimi-agent/src/tools/plan_mode.rs` | ✅ **100% 原生** | 计划模式激活期间，严格拦截除指定计划文件外的任意写操作与破坏性工具。 |
| **G-6 #2: 工具重复调用去重**| `agent-core-v2/src/agent/toolDedupe/` | `kimi-agent/src/tools/tool_dedupe.rs` | ✅ **100% 原生** | 识别并阻止同一 turn 内相同参数的只读工具重复执行，直接复用历史缓存。 |
| **G-6 #3: 盲写陈旧防护**| 无上游对应物（fork 自研） | `kimi-agent/src/tools/stale_guard.rs` | ✅ **fork 自研** | 写操作前置校验文件自读取以来的修改时间戳（mtime），防止并发冲突与盲写覆盖。**2026-09-19 更正出处**：上游 `features/staleGuard/` 已在 a020946916（#3517）删除，现行 v2 只剩死字符串；所述「v2 记录 mtime 并否决写」的上游行为从未存在（v2 仅有 readTool 的读侧 TOCTOU 检查）。本模块是 fork 原创并自行接线。 |
| **G-6 #6: PreToolUse 钩子**| `agent-core-v2/src/features/externalHooks/` | `kimi-agent/src/tools/external_hooks.rs` | ✅ **100% 原生** | 在工具执行前同步触发用户自定义外部钩子，超时（Fail-Closed）或返回非零时立即拦截。 |
| **G-6 #7/#8: Goal 准入与过期**| `agent-core-v2/src/features/goal/` | `kimi-agent/src/tools/goal_guard.rs` | ✅ **100% 原生** | 阻断在不合法状态下启动新 Goal，并在检测到 Goal 快照过期时强制拒绝工具调用。 |
| **G-6 #12: Tower TodoList 否决**| `agent-core-v2/src/features/tower/` | `kimi-agent/src/tools/tower/mod.rs` | ✅ **100% 原生** | P154：Tower 模式下即时否决子代理调用 TodoList，防止舰队任务串行化。 |
| **G-6 #13: Worker 工作区写隔离**| `agent-core-v2/src/features/tower/` | `kimi-agent/src/tools/tower/mod.rs` | ✅ **100% 原生** | P154：强制校验 Tower Worker 写操作的目标路径，越界逃逸立即否决，杜绝跨分支污染。 |

### 板块 5：上下文管理、压缩与动态注入

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **上下文智能压缩** | `agent-core-v2/src/agent/fullCompaction/`<br>`microCompaction/` | `kimi-agent/src/compaction/mod.rs`<br>`src/compaction/micro.rs` | ✅ **100% 原生** | 基于滑动窗口的上下文裁剪，保留系统提示词、用户首轮意图与最近尾部消息；中段消息结构化提取为第一人称摘要；精准对齐 CJK/多模态/JSON Token 预算。`microCompaction` 已补齐（`compaction/micro.rs`，326 行 + 7 个单测，数字于 2026-09-15 复核）：把超过 `min_content_tokens` 的旧工具结果内容清空，变换是确定性投影，store 保留原文，因此重建出的前缀跨请求稳定。由 `server/engine.rs` 在每轮构建 pipeline 后按 `[experimental].micro_compaction` 应用，并发布 `micro_compaction.apply` 事件。**与 v2 的差异**：v2 额外以「检测到 prompt-cache miss」为触发条件，该信号尚未接入引擎，目前仅由开关决定。 |
| **提醒与节律注入** | `agent-core-v2/src/features/reminder/` | `kimi-agent/src/injection/mod.rs`<br>`src/injection/goal_plan.rs`<br>`src/injection/permission_mode.rs` | ✅ **100% 原生** | `<system-reminder>` 包装与识别。内置日期变更注入、工作区 AGENTS.md 动态提醒、Goal 预算耗尽与 Plan-Mode Cadence 节律注入、权限模式进入/退出 auto 的两段提醒，压缩操作不丢失注入块。**2026-09-15 补齐**：v2 的 `permission_mode` 变体（`agent-core-v2/src/agent/permissionMode/injection/permissionModeInjection.ts`）此前在 fork 中整体缺失，现已落地为 `injection/permission_mode.rs`（两段文案 + 进入/退出转移 + 历史基线扫描 + `KIMI_CODE_PERMISSION_MODE_REMINDER` 门禁）。**与 v2 的差异**：v2 从 agent state 读 `permissionMode.lastMode`、从历史读该变体自己的 `injectedPositions`；fork 两者都从历史扫描恢复（`scan_permission_mode_baseline`），因此「提醒被压缩/撤销掉后重新宣告」与「恢复会话不重复宣告」两种行为都成立。模式来源是 host 传入的 `PolicySnapshot.mode`（`RunTurnInput.permission_mode`），不新增 napi 参数。 |

### 板块 6：系统提示词与 Profile 角色目录

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **系统提示词构建** | `agent-core-v2/src/app/agentProfileCatalog/`<br>`system.md`, `profile-shared.ts` | `kimi-agent/src/prompt/builder.rs`<br>`src/prompt/system.md` | ✅ **100% 原生** | P156 SystemPromptBuilder：内嵌标准 Markdown 模板，支持 `${product_name}`、`${role_additional}`、`${reply_style_guide}`、`${os}`、`${shell}`、`${cwd_listing}`、`${agents_md}`、`${skills_section}` 变量插值。 |
| **环境探测与目录树** | `agent-core-v2/src/agent/profile/context.ts` | `kimi-agent/src/prompt/environment.rs` | ✅ **100% 原生** | 原生跨平台探测 OS 与 Shell 路径，调用 `native_list_directory` 输出紧凑两级目录树（折叠隐藏目录，根宽30/子宽10），Windows 自动注入 Unix shell 指南。 |
| **AGENTS.md 级联** | `agent-core-v2/src/agent/profile/context.ts` | `kimi-agent/src/prompt/agents_md.rs` | ✅ **100% 原生** | 逐级向上级联发现 `~/.kimi-code/AGENTS.md`、`~/.agents/AGENTS.md` 与工作区 `AGENTS.md`，注入 `<!-- From: ... -->` 来源头，内置 32KB 预算告警。 |
| **技能清单 Markdown** | `agent-core-v2/src/app/agentProfileCatalog/` | `kimi-agent/src/prompt/skills_renderer.rs` | ✅ **100% 原生** | 扫描 Project / User / Built-in 技能，按作用域分级排版为标准 Markdown 表格，自动过滤 `disable_model_invocation` 私有技能。 |
| **Profile 角色注册表**| `agent-core-v2/src/session/agentLifecycle/`<br>`profile/profiles.ts` | `kimi-agent/src/prompt/profiles.rs` | ✅ **100% 原生** | 原生提供 `agent`（全功能）、`coder`（带交接 Handover 强化）、`explore`（只读探索）与 `plan`（架构规划）预设角色与工具许可清单。 |

### 板块 7：本地守护服务端（REST + WebSocket）

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **REST API 全路由** | `packages/kap-server/src/routes/`（上游 41 个文件） | `kimi-agent/src/server/router.rs`<br>`src/server/http.rs`, `fs_routes.rs` | ✅ **100% 原生** | 原生提供 `/api/v1` 全量接口：`/sessions` (CRUD, status, abort, fork)、`/workspaces`、`/skills`、`/models`、`/mcp`、`/plugins`、`/terminals`、`/fs` 等。 |
| **WebSocket 全双工** | `packages/kap-server/src/transport/ws/` | `kimi-agent/src/server/ws.rs`<br>`src/server/hub.rs` | ✅ **100% 原生** | RFC 6455 协议支持，实现打字机推流（stream.delta）、思考流（thinking.delta）、工具进度（tool.progress）、双向 Prompt/Cancel 控制帧与心跳 Ping/Pong（含 40112 鉴权）。**2026-09-19 更正路径**：上游无 `kap-server/src/ws/` 目录，实际在 `src/transport/ws/`。 |
| **虚拟终端 PTY** | `packages/kap-server/src/routes/terminals.ts`<br>+ `src/protocol/rest-terminal.ts` | `kimi-agent/src/server/terminal.rs` | ✅ **100% 原生** | 跨平台终端管理，基于 `portable-pty`（wezterm）：每个终端是一个真伪终端，REST 创建/列出/关闭 + WebSocket 二进制双向吞吐，`resize` 经 `MasterPty::resize` 下达 `TIOCSWINSZ`/`ResizePseudoConsole` 给子进程，Ctrl-C、作业控制与 `isatty` 行为与真终端一致。**2026-09-19 更正路径**：上游无 `kap-server/src/terminal/` 目录。 |
| **静态资产与 SPA** | `packages/kap-server/src/routes/webAssets.ts` | `kimi-agent/src/server/static_files.rs` | ✅ **100% 原生** | 内置静态 Web 资源托管与 SPA 前端回退路由支持。 |

### 板块 8：客户端 SDK 与通讯协议

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **ACP 协议宿主** | `packages/acp-server/` | `kimi-agent/src/acp/mod.rs`<br>`src/acp/types.rs` | ✅ **100% 原生** | 原生 Agent Client Protocol (ACP) 规范实现，支持 Stdio 与网络通道，零 Node 依赖。**2026-09-15 审计列出的七项缺陷已全部修复（2026-09-19 复核代码逐项确认）**：`stopReason` 经 `acp/events_map.rs:59-66` `turn_stop_reason_to_acp` 映射为 `end_turn`/`cancelled` 等 ACP 词表（测试 `acp/mod.rs:3075` 起）；`$/cancel_request` 已处理（`acp/mod.rs:1120-1125`）；`terminal/kill` 有调用点（`acp/permission.rs:161-163`，定义在 `channel.rs:237-240`）；`additionalDirectories` 已读取并持久化（`acp/mod.rs:645,690-692`，运行期追加显式拒绝并告知）；Bash 反向改道经 `resolve_shell` 解析引擎 shell（`acp/permission.rs:107-110`）；`session/set_model` 已服务（`acp/mod.rs:1143` 起）。反向 RPC 为 9 个（其中 `terminal/kill` 此前无调用点的缺陷已随上一项闭环）。 |
| **Stdio JSON-RPC** | 无（仓内无 TS 调用方） | `kimi-agent/src/rpc/types.rs`<br>`src/main.rs` | ⚠️ **Rust 侧就绪，TS 侧未接线** | Rust 侧提供严格匹配 LSP/JSON-RPC 2.0 规范的 Stdio 双向通讯层；但仓内没有任何 TypeScript 客户端调用它——`apps/kimi-code/src/cli/rust-engine.ts` 只是 bundle 存在性检查，不是 RPC 客户端。实际运行路径是 napi addon（`session-handle.ts` → `NapiSessionTransport`）。 |
| **客户端 SDK 门面** | `packages/klient/src/` | — | ✅ **已退役** | `packages/klient` 已按 P159 物理删除（连同 `agent-core-v2` / `acp-server` / `kap-server`）。消费方直连 Rust REST/WebSocket/NAPI。见本文件 §4 与「工作区状态」。 |

### 板块 9：多智能体协作与 13 大领域高级特性

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **Tower 多工作区协作**| `agent-core-v2/src/features/tower/` | `kimi-agent/src/tools/tower/` | ✅ **100% 原生** | 原生管理 Git Worktree、分支派生与合并、Mission 状态追踪与 Worker 工作区写隔离。 |
| **AgentSwarm 批处理** | `agent-core-v2/src/features/swarm/` | `kimi-agent/src/swarm/`<br>`src/tools/swarm_tool.rs` | ✅ **100% 原生** | 原生批量派发并发子代理，内置速率限制自适应收缩与弹性恢复算法。 |
| **Team 辩论共识引擎** | Fork 特色增强功能 | `kimi-agent/src/team/` | ✅ **100% 原生** | 原生实现多 Agent 轮换辩论、跨评估与共识收敛协议。 |
| **Goal 目标状态机** | `agent-core-v2/src/features/goal/` | `kimi-agent/src/goal/`<br>`src/tools/goal_tools.rs` | ✅ **100% 原生** | 完备实现 Token、Turn 与 Wall-Clock 三维预算管理，支持状态变更事件与 Deadline 调度器。 |
| **Cron 定时任务** | `agent-core-v2/src/features/cron/` | `kimi-agent/src/cron/`<br>`src/tools/cron_tools.rs` | ✅ **100% 原生** | 标准 5 字段 Cron 解析、Jitter 防羊群效应偏移、合并触发计数与 7 天生命周期管理。 |
| **TodoList 进度追踪** | `agent-core-v2/src/features/todo/` | `kimi-agent/src/storage/state_store.rs` | ✅ **100% 原生** | 原生维护 Todo 树结构、父子 Milestone 关联及完成进度计算。 |
| **Skill 技能系统** | `agent-core-v2/src/features/skill/` | `kimi-agent/src/skills/`<br>`src/tools/skill.rs` | ✅ **100% 原生** | 目录递归探测、YAML Frontmatter 解析、命令行参数宏展开与执行调度。 |
| **Plan / Stale / Hooks**| `features/plan/`（上游）；`staleGuard/`（无上游对应物）、`externalHooks/`（上游） | `kimi-agent/src/tools/` 对应原生模块 | ✅ **100% 原生** | 计划模式审批锁、盲写防护、Pre/PostToolUse 钩子执行全面闭环。**2026-09-19 更正**：上游 staleGuard 已删除（a020946916），`stale_guard.rs` 为 fork 原创（见板块 4 G-6 #3 行）。 |

### 板块 10：持久化存储与底层数据模型

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **会话与状态持久化** | `packages/minidb/`<br>`agent-core-v2/src/persistence/` | `kimi-agent/src/session/sqlite_store.rs`<br>`src/storage/state_store.rs` | ✅ **100% 原生** | 采用嵌入式 SQLite（`rusqlite`）替代 TS 内存加 WAL 的 minidb，实现事务级一致性与跨进程多路访问。 |
| **状态增量更新** | `agent-core-v2/src/state/` | `kimi-agent/src/session/patch.rs` | ✅ **100% 原生** | 严格实现 RFC 6902 JSON Patch 递归差异对比算法，毫秒级输出最小增量变更集。 |
| **转录流数据层** | `packages/transcript/` | `kimi-agent/src/native/event_store/`<br>`kimi-agent/src/events/` | ✅ **100% 原生** | 原生 EventStore 与事件分类模型，实现跨平台同构事件折叠。 |

---

## 2. 上游最新特性跟踪与语义分叉深度审计（Upstream Delta）

基于对 `upstream/main` 最近合并提交的精确比对分析，Rust 引擎对应的支持状态如下：

1. **#3478：重启后从持久化记录恢复子代理（Rebuild persisted subagents on resume）**
   - **上游行为**：当调用 `Agent(resume=<id>)` 且目标子代理因服务重启不在内存名册中时，读取会话元数据并从历史快照重建代理作用域，恢复权限模式。
   - **Rust 对标**：✅ **已闭环（P157）**：`subagent/manager.rs` 现已完全对接 `SqliteSessionStore`（`with_store` / `set_session_store`），内存未命中时自动从 SQLite 的 `subagent_resume` 域反序列化恢复历史快照、角色元数据及实例状态，支持无缝续接冷恢复（配有完整单元测试断言）。
2. **#3459：强制停止交接步与停止原因传播（Handoff step after forced stop）**
   - **上游行为**：当工具重复熔断（repeat_breaker）强制停止时，循环额外执行一步纯文本交接步（Refuse 工具调用），并在结果上报 `stop_reason` 与 resume_hint。
   - **Rust 对标**：已实现——`run_turn.rs` 的 RepeatBreaker 分支在熔断后追加纯文本交接步并复用 `turn_stop_reason_from_finish` 上报原因（upstream #3459 对齐）。
3. **#3484 / #3430：分层遥测上下文（Layered Telemetry Registry）**
   - **上游行为**：重构 Telemetry 上下文为作用域分层注册表，将绑定的模型与环境注入事件。
   - **Rust 对标**：`TurnResult` 已具备 `llm_retries`、`events_emitted` 与 `latency_ms` 字段，且 `turn_step.rs` 在指数退避重试时原生发出对标 `TurnStepRetrying` 的结构化遥测事件（含 failed_attempt, next_attempt, max_attempts, delay_ms），已满足原生遥测闭环。

---

## 2.5 引擎语义对齐批次（P156.5 / P157）与本批差异消除记录

> 标题原标题为「已知差异（**已全部消除**）」，与文末「未闭环项」自相矛盾，故更正：
> **本批列出的差异已消除，但引擎整体仍有未闭环项**（remote-control 服务端运行时、fs watch、
> `apps/vis` 回退），见文末。

> 本节为 2026-09-06 语义审计与落码后的真实状态记录。对齐参照（v2 源码）已被工作区删除，
> 以下 TS 引用行号以上游 git 历史（`git show HEAD:packages/agent-core-v2/...`）为准。

**本批已消除的语义差异**：

| 项 | v2 行为 | 此前 Rust 行为 | 修复后 |
|---|---|---|---|
| 工具结果 stopTurn | 任一结果 `stopTurn:true` → turn 以 completed 收尾（loopService.ts:2117-2119） | 字段整体丢弃，goal/plan 工具无法止轮 | `ToolExecuteResponse`/`ExecutableToolResult` 全链路透传，`run_turn` 以 EndTurn 收尾；update-goal/set-goal-budget/exit-plan-mode 按 TS 条件置位 |
| 批内跳过 stopBatchAfterThis | 任一工具 stopTurn/stopBatchAfterThis → 批内后续工具跳过执行（toolExecutorService.ts:380,450） | 后续工具仍继续执行，直至所有工具结束 | `tool_scheduler::execute_scheduled` 捕获 `stop_turn` 后自动短路，后续批次全量填充 v2 标准跳过文案 `Tool skipped because a previous tool call stopped the turn.` |
| 重试遥测事件 TurnStepRetrying | 每次重试派发 `TurnStepRetrying`，载荷含 failedAttempt / nextAttempt / maxAttempts / delayMs 与 `retryErrorFields`（errorName / errorMessage / statusCode）（loopService.ts:1571-1585，载荷定义 turnEvents.ts:163） | 仅在最终结果有 `llm_retries` 计数 | `turn_step.rs` 每次指数退避前结构化派发 `TurnStepRetrying` 事件，载荷携带 failed_attempt / next_attempt / max_attempts / delay_ms 及 error_name / error_message / status_code |
| 子代理冷恢复 (#3478) | 服务重启后从历史快照重建代理作用域与历史并恢复对话 | 仅查内存 `foreground_histories`，重启后无法 resume | `SubagentManager` 对接 `SqliteSessionStore`，未命中时自动从 SQLite 反序列化重建状态并无缝续接对话 |
| NAPI 通道沙箱策略透传 | NAPI 层根据 sandbox_mode 构建沙箱守卫 | `sandbox_policy` 恒为 None | `napi_bindings.rs` 显式由 `params.sandbox_mode` 与 `workspace_root` 派生 `SandboxExecutionPolicy` 并透传至 pipeline |
| REST 服务端缺失域覆盖 | 支持 providers/catalog, prompts, /api/v2, plugins, skills, acp | 多个端点返回 404 | 补齐 `GET /api/v1/providers`, `GET /api/v1/catalog/providers`, `POST /api/v1/models/{tail}`, `GET/POST /api/v1/prompts`, `GET /api/v2/sessions`, `POST /api/v1/plugins`, `GET /api/v1/skills`, `POST /api/v1/acp` 等 |
| WebSocket 事件词汇对齐 | 支持 work_changed, session.meta.updated, tool.call 等契约事件 | 仅 13 种基础事件 | `EngineEvent` 强类型扩充 `event.session.work_changed`, `tool.call.completed/failed`, `session.meta.updated`, `event.config.updated`, `subagent.spawned/completed/failed` |
| 未声明 accesses 的并发回退 | `?? ToolAccesses.all()` → 与一切串行（toolExecutorService.ts:437） | 未知工具 → 空（并行放行，fail-open） | 未知工具/bash → `all`；github/agent/fetch/web_search 显式 none（对齐各自声明） |
| 沙箱命令执行 | （v2 sandbox 为死代码；对齐本 fork SandboxGuard 自身语义） | ReadOnly 拦截不到 Bash | `run_code \| bash` 共用执行守卫，拒绝先于 shell 派生 |
| 重试参数配置 | 默认 10 次、可配 `maxAttemptsPerStep`、{408,409,429,500..529}、配额豁免 | 硬编码 3 次、缺 409、无配额豁免 | 默认 10 可配（`max_attempts`），可重试集含 409，429 配额文案豁免 |
| max_steps 耗尽 | turn failed + interrupt_reason=`max_steps` + 错误文案（loop.ts:20-27） | 与正常完成不可区分 | `MaxSteps` 变体 → failed + turn.ended error payload；`Filtered` 同改 failed（对齐 loopService.ts:877-882） |
| LLM 取消 | AbortSignal 贯穿，取消 → turn cancelled | 无取消句柄，请求发出即不可中断 | `LLMChatParams.cancel`（CancellationToken）贯穿 send/SSE/竞速败者，watcher 桥接 AtomicBool，取消错误不重试 |
| Tower 速率限制自适应控制 | 派发 worker 经 RateLimitCapacityGovernor 限流并在 status 报告并发度 | 未实现并发上限限制与状态输出 | 新增 `tools/tower/rate_limit.rs` 完整实现自适应退避与容量恢复，`TowerSpawn` 派发受控并在 `TowerStatus` 报告自适应并发 |
| 会话初始化与 AGENTS.md 生成 | 支持 /init 引导代码库分析与生成 AGENTS.md | 未迁移 init 提示词与会话端点 | 新增 `prompt/init.rs`，导出 `DEFAULT_INIT_PROMPT` 与 `init_completion_reminder`，挂载 `POST /api/v1/sessions/{id}:init` |
| 工作区动态属性更新 | 支持 PATCH /api/v1/workspaces/{id} 重命名与元数据更新 | 缺失该 REST 动词 | `sqlite_store.rs` 实现 `update_workspace_name`，并在服务端完整接入 `PATCH /api/v1/workspaces/{id}` |
| Debug 反射面 (/api/v1/debug/*) | 支持 kimi-inspect 调试器探查渠道、快照与 RPC 调用 | 原生端点缺失，返回 404 | 新增 `server/debug.rs`，实现 `/api/v1/debug/channels`、业务快照与动态服务方法调度器，全面兼容 kimi-inspect |
| 文件变动回滚与持久化撤销清理 | undo 时级联清理文件历史并在请求时还原工作区受影响文件 | undo 仅删除 messages 与 turns，无文件回滚 | **已完成并接线（2026-09-14 复核）**：`sqlite_store.rs` 实现了 `revert_turn_file_changes` 并级联删除 `session_file_history`，服务端 undo 端点接入物理恢复（`server/mod.rs:3554-3582`），且生产写入方已接上——`HostCallbacks::set_file_history`（新增的默认 no-op seam）由 `server/engine.rs` 在每轮构建 pipeline 后调用，落到 `NativeToolset` 的共享 recorder；turn 归属经 `with_turn_id`/`set_turn_id`（原 `scope_turn_id` 线程局部在 `spawn_blocking` 线程上不可见，已删除）。测试 `tools::tests::write_records_file_history_and_revert_restores_the_file` 断言全链：Write → 记行 → 回滚恢复原文件/删除新增文件。 |
| REST `:compact` 的摘要 | 手动压缩把省略的前缀折叠为模型写的摘要 | 端点走 `store.compact_session` → `force_compact_messages_manual` → 固定占位文案；NAPI 路径（TUI）一直是真摘要，同一个「压缩」动作两条路两种历史 | **已修复（2026-09-14）**：端点先经 `ServerEngine::session_llm` 取会话模型，用 `summarize_with_llm` 摘要即将折叠的前缀，再交 `compact_session_with_summary` 落库；无可用模型时回退占位文案。`build_llm_for_spec`（pipeline）与 `session_spec`/`session_callbacks`（engine）从 turn 路径抽出，两条路共用同一条 LLM 选择链。测试 `server::tests::the_compact_route_writes_the_llm_summary_not_the_placeholder` 与 `session::sqlite_store::tests::test_compact_session_with_summary_writes_the_summary`。 |

**MCP 连接管理器对齐（2026-09-08）**：

| 项 | v2 行为 | 此前 Rust 行为 | 修复后 |
|---|---|---|---|
| 意外关闭主动通知 | `watchForUnexpectedClose` 注册回调，传输死亡时主动标记 failed + 清空 tools + emit（connection-manager.ts:321-341） | 仅 `server_entries()` 惰性检查 `is_closed()`，status_listeners 收不到通知 | `McpClient.on_unexpected_close` + `pending_close_reason` 缓冲（stdio/SSE 传输），`McpManager::watch_unexpected_close` 以 `Arc::ptr_eq` 身份检查防竞态，意外关闭时标记 failed 并通知监听者 |
| needs-auth 判定 | `shouldMarkNeedsAuth`：静态 headers / bearerTokenEnvVar 存在时不进入 needs-auth；`isUnauthorizedLikeError` 嗅探（connection-manager.ts:383-393,473-483） | 仅 `e.contains("401")` 字符串嗅探，无豁免 | `should_mark_needs_auth` 完整判定：oauth 已装 + remote + 无静态凭据 + 401/unauthorized 嗅探 |
| 启动失败 stderr 诊断 | `formatStartupError` 附加子进程 stderr 尾部（connection-manager.ts:485-509） | 无 stderr 捕获 | stdio 子进程 stderr 有界尾部（4 KiB），启动/发现失败时附加到错误文本 |
| 并行连接 | `connectAllNow` 并行 + `Promise.allSettled` 隔离（connection-manager.ts:229-246） | `spawn_from_config` 串行 for 循环 | `futures_util::future::join_all` 并行连接，失败隔离 |
| 工具名碰撞 | `registerMcpServer` 检测同服务器/跨服务器 qualified name 冲突并 drop（mcpService.ts:186-215） | HashMap 静默覆盖 | `register_client` 检测碰撞并 `tracing::warn!` 记录，输家工具被 drop |
| disabled 重连 | `reconnect` 对 disabled 抛 `MCP_SERVER_DISABLED`（connection-manager.ts:146-164） | 直接重连 | `reconnect_inner` 检查 `ToolFilter.enabled`，disabled 返回错误 |
| emit 日志与容错 | `emit` 在 failed/needs-auth 记 error 日志，listener 异常被捕获（connection-manager.ts:425-442） | 无日志，listener panic 传播 | `emit_status` 加 `tracing::error!` + `catch_unwind` 容错 |
| 状态变更上抛宿主 | `mcpService.attachMcpTools` 订阅 `onStatusChange`，把每次变更作为 observable `McpServerStatus` 事件派发（`agent/mcp/mcpService.ts:154-180`） | `on_status_change` 只被测试引用，引擎从不发 `mcp.server.status`：`EngineEvent` 无该变体、`emitEvent` 无该分支 —— TUI 启动状态行永远停在 `pending` | `napi_bindings.rs::attach_mcp_status` 在会话构建时订阅共享 manager，每次变更经**未包装**的 `HostCallbacks::emit_event` 上抛（不进计数遥测、不走事件总线），随 `session_dispose` 退订（`McpStatusBridge` 的 `Drop`）；`sdk-rpc-client-native.ts::emitEvent` 映射为协议 `mcp.server.status`（带 `sessionId`/`agentId`）。v2 的初始 roster 重放刻意不做：它发生在宿主订阅之前（事件会丢），且在宿主快照已渲染 `connected` 后重放旧的 `pending` 会复活一个永不停止的 spinner —— 宿主自己的 roster 快照就是初始同步 |

**语义差异（已全部消除）**：

1. ~~沙箱仅覆盖 write/edit 路径级 + 命令执行；TS 的 bash 拦截层是 permission 策略链（与沙箱无关），Rust 的 permission 链是否等价覆盖命令 glob 审批未在本批审计。~~ **已解决**：`permission/mod.rs` 的策略链新增 fork 专属 `DangerousCommandAsk`（#3），对 bash 调用 `kimi_native_tools::permission_engine::dangerous_command::analyze_bash_command`，高风险命令（shutdown/reboot/rm -rf/format/sudo …）在 Yolo/Auto 下也强制 Ask，对齐 native-tools `test_yolo_mode_refuses_dangerous_reboot` 语义。
2. ~~kimi-agent/src/native/event_store/ 的细粒度事件账本未完整接入 standalone server；session/patch.rs（RFC 6902）无全局生产调用点。~~ **已解决**：event_store 经 `hub.set_persister` 对每个事件落账（server/mod.rs:88-104），fold/checkpoint/undo 已接入；session/patch.rs 由 REST state-PATCH/undo-redo（server/mod.rs:3345-3467）、sqlite_store.rs:1130-1153 与 state_store.rs:187-205 生产调用。persister 错误现已结构化记入 warn 日志；standalone 的 TaskRunner 为进程内内存任务提供生命周期事件分发。
3. ~~standalone 服务端面仍有大量 mock/缺失（2026-09-09 审计修正，此前"均已对齐"结论失实）~~ **已完成（2026-09-11）**：Wave 3 服务端契约与 Wave 4 新能力全部落地——transcript L1/L2（`/transcript`、`/ops`、`/user-messages`、`/plan`，从持久化历史重建 + turn 游标分页）、prompt 侧附件 intake（`POST /prompts` 解析 `content[]`、`f_`/`path` → 原生媒体块注入模型）、debug 三方法（association/runtime-binding/workspace-snapshot）按契约整形且未知方法 404、WS 词汇黄金契约 `ws-event-contract.json`（Rust / kimi-web / protocol 三方断言）与 `event.model_catalog.changed` 发射、ACP（`session/new` 的 `cwd`/`mcpServers`、`fs`/`terminal` 反向 RPC 与 Read/Write/Bash 执行改道、`elicitation/create` 表单桥 + `session/request_permission` 回退，客户端反向 RPC 9 个，其中 `terminal/kill` 无调用点）、Workflow 引擎（内嵌 QuickJS，JS 运行时经 `workflow-js` feature 可选，9 内置工作流 + `Workflow` 工具接线）。校验：`cargo test --lib` 2,349 项（2026-09-15 复核，原写 2,107） + `--tests --features cli` 全绿，clean 构建两种 feature 组合均通过。已知边界（非缺口）：kimi-web 标注为 no-op 的 4 个事件、`elicitation/complete`（规格可选）、`session/set_model`（引擎无运行时模型目录）。
4. ~~**只读工具漏进 `FallbackAsk`（2026-09-20 复核新增）**~~ **已闭环（2026-09-21）**：`DEFAULT_APPROVE_TOOLS` 只镜像了 v2 名单 + `ListDirectory`，fork 自有的只读工具（`Lsp`、`memory_read`/`memory_list`、`TowerInbox`/`TowerStatus`）没进名单，于是在 Manual（"Always Ask"）下这些纯读调用也弹审批——与 v2「只读工具免审」的语义不一致。**已落地**：上述工具（含下划线/紧凑两种拼写）已补进 `permission/mod.rs:86-94` 的名单；测试 `test_default_tool_approve_for_all_readonly_tools` 的 21 条用例断言 `DefaultToolApprove`。**混合读写工具经 v2 参考裁定为「不适用」**：`Knowledge`（search/stats 只读，add/confirm/reject/remove/import 写）与 `TowerMission`（inspect 只读 / update 写）按 `action` 拆分的设想**不成立**——v2 的 `default-tool-approve.ts` 是扁平名字判定且**不含这两个工具**，全部 13 个 permissionPolicy 也无一提及它们；即 v2 对它们的所有 action 一律走 `fallback-ask`，fork 现状（不在名单、Manual 下弹审批）与 v2 逐字一致。按 `action` 拆分免审会是发明 v2 没有的行为，按铁律不做。
5. ~~**对话中切换权限模式不落库（2026-09-20 复核新增，SDK 侧）**~~ **已闭环（2026-09-21 复核确认）**：`node-sdk` 的 `applyRebuiltSetting`（`setPermission` / `setModel` / `setThinking` / `setSwarmMode` 共用，`sdk-rpc-client-native.ts`）只改内存 `meta` 并 `rebuildHandle`，**没有 `persistMeta`**；同文件的 `addAdditionalDir` 却会落库。后果：对话中切到 yolo 后 `session-meta.json` 仍是旧模式，`resumeSession` 用旧模式建引擎，而 replay 头（`session-replay.ts:725`）显示引擎自己记录的 yolo —— 表现为「界面 yolo、实际 manual」，恢复会话后只读工具又开始弹审批。**已落地**：`applyRebuiltSetting` 重建成功后 `persistMeta(meta)`（失败回滚旧值不落库）；回归测试 `session-set-permission.test.ts` 的「persists the mode so a resumed session keeps it」在位。
6. ~~**原生 SDK 丢弃引擎事件（2026-09-20 复核新增，SDK 侧）**~~ **已闭环（2026-09-22 复核确认标题）**：`sdk-rpc-client-native.ts::emitEvent` 此前只映射 `llm.delta`(text/think) / `tool.native` / `tool.native.progress` / `subagent.spawned`(仅写 meta，不转发) / `warning` / `error`，其余一律丢弃。引擎经 `HostCallbacks::emit_event` 实际还会发 `subagent.started/completed/failed/cancelled`（`tools/agent_tool.rs`）、`llm.step.begin`/`llm.step.end`（`llm/http.rs`，原生 LLM 路径）、以及 `llm.delta` 的 `tool_call` 分片（`llm/wire.rs::StreamDelta::to_part`）——这些都没有分支，TUI 的 `turn.step.*`、`subagent.*` 生命周期与 `tool.call.delta` handler 永不触发。修法：补齐映射（`llm.step.begin/end` → `turn.step.started/completed`，步号由 host 合成、`turn.started` 时重置；`tool_call` 分片 → `tool.call.delta`；`subagent.spawned` 转发并保留 meta 写入；`subagent.started/completed/failed/cancelled`；`usage` 由 `toTokenUsage` 转 camelCase）。验证：真实 SDK + 真实引擎 + mock OpenAI SSE 的探针（`native-harness.test.ts` 新增「forwards native-LLM step and subagent lifecycle events to onEvent」）断言 `turn.step.started/completed`、`subagent.spawned/started/completed` 到达 `onEvent`；node-sdk 全量 279 项通过。**仍未接线**：`background.task.started/terminated` 在 napi 路径没有生产者（`storage/task_runner.rs` 的 `event_sink` 只在 `server/mod.rs` 设置），`cron.fired` 同理（native host 无 cron 派发器）；要补需在 napi pipeline 给 task runner 装 sink。 **2026-09-20 后续补齐（本项已闭环，`cron.fired` 除外）**：① `background.task.*` —— `PipelineHost` 新增 `task_event_sink`，pipeline 给自己的 `TaskRunner` 装上（napi 传「转发到 host callbacks」的 sink），SDK 把 `event.task.created/completed` 映射成协议 `background.task.started/terminated`（`kind: subagent→agent，其余→process`；agent 任务的 `taskId` 即 agentId）。② 自动压缩 —— turn loop 两个压缩点（step 前阈值、溢出应急）发 `compaction.started/completed/cancelled`；为拿到 summary/token 数新增 `compaction::CompactionReport` 与 `compact_messages_with_summary_at_report` / `force_compact_messages_with_summary_report`（旧入口委托并丢弃 report，签名不变）。③ `hook.result` —— `HookGuard` 新增 `with_hook_result` sink，`run_hook_with_denial` 返回 `(block reason, stdout)`，PreToolUse 与 observe-only 各路径都上报；pipeline 把 sink 接到 `emit_event`。④ `goal.updated` —— SDK 的 `createGoal` 与逐轮 goal 计数后各发一次（此前无任何生产者）。⑤ `shell.started/output/completed` —— SDK 的 `runShellCommand` 在 `nativeBashSpawn` 回调里边跑边发。验证：`native-harness.test.ts` 新增 `background.task` 与 `goal.updated` 两条用例；`external_hooks.rs` 新增 `denial_emits_a_hook_result_per_hook`；`cargo test --lib` 2764、napi 集成 60、node-sdk 281 全绿。**仍未接线**：`cron.fired` —— CLI 下 CronCreate 的定时任务不会触发（native host 无派发器），需在 napi 会话移植 `main.rs:1429` 的 15s tick 循环（emit + enqueue turn），属功能移植；`tool.list.updated` 的 TUI handler 是 no-op，不做。 **2026-09-21 cron 派发器已移植**：`napi_bindings.rs` 新增 `spawn_cron_dispatcher`（每个 workspace 一个进程级 dispatcher，每 15s 经 `live_session_for_workspace` 取一个活着的会话，`state_read("cron")` 读注册表 → `CronScheduler::tick` → 发 `cron.fired` + 删一次性/过期任务 + `enqueue_turn` 跑 `<cron-fire>` 轮），`SessionEntry` 补 `workspace`/`callbacks` 以便每 tick 解析活会话（设置重建会换会话句柄，按 workspace 归属才不会丢）；SDK 映射 `cron.fired` → 协议 `{origin, prompt}`。验证：确定性探针（直接按 `storage/paths.rs` 的 FNV-1a key 写 `<USERPROFILE>/.kimi-code/engine-state/<key>/state/cron.json`，等 dispatcher tick）连续 3 次都发出 `cron.fired` 且一次性任务被删；napi 集成 60、node-sdk 281 全绿。`tool.list.updated` 仍不做。
7. ~~**Tower 状态文件 schema 与 v2 不一致（2026-09-20 复核新增）**~~ **已闭环（2026-09-21 复核确认）**：v2 的 `.tower/comms/state.json` 是 camelCase 契约（`agent-core-v2/src/features/tower/protocol/types.ts`：`createdAt`/`sessionId`/`agentId`/`spawnedAt`/`reviewTarget`/`reviewMissionId`/`diedAt`/`deathStatus`/`deathReason`，mission 的 `spawnBase`/`context`），fork 的 Rust `types.rs` 却曾是 snake_case 且无 `rename_all` —— 任何 v2 写的状态读回即 `corrupted tower state: missing field \`created_at\``，整套 tower 工具不可用（用户 memory 里的「Tower 状态损坏不可用」）。**已落地**：`TowerState`/`TowerRosterEntry`/`TowerMission` 均有 `#[serde(rename_all = "camelCase")]`（`types.rs:11/117/149`），v2 有而 fork 缺的字段（`spawnBase`/`context`、`reviewMissionId`/`diedAt`/`deathStatus`/`deathReason`）为可选透传，Option 字段带 `#[serde(default)]`；`types.rs` 两条单测（读含全部字段的 v2 camelCase、缺可选字段仍可读；写回 camelCase）在位。**已知分歧（未改）**：fork 用单字段 `status: "dead"` 表达 worker 死亡，v2 用 `diedAt`/`deathStatus`/`deathReason` 三字段 —— `mark_agent_dead` 仍写 `status`，v2 三字段只做透传。

> **工作区状态（2026-09-06 更新）**：P157–P161 已落地——`agent-core-v2`/`klient`/`acp-server` 已物理删除，
> `kimi-native-tools` 已并入 `packages/kimi-agent/src/native/`（单 crate、单 `.node`、单 npm 包），
> TS 侧消费方（kap-server compat 层、node-sdk、kosong、i18n、apps/kimi-code）全部改指原生引擎，
> `bun run typecheck` / `lint` 全绿。终态门禁 `scripts/check-no-legacy-engine.mjs` 已接入 CI lint job。

---

## 3. v2 消费方 370 处静态引用点逐包拆解（**历史记录，已全部清零**）

> **状态（2026-09-14 复核）**：本节是解耦前的盘点快照，**不是待办**。
> 5 个消费方全部已处理完毕：`agent-core-v2` / `kap-server` / `klient` / `acp-server` 已物理删除，
> `node-sdk` 已改指原生引擎。这 370 处**代码依赖**已清零；`packages/`、`apps/` 下仍有约 319 处
> 提到 `agent-core-v2` 的**字符串**，但复核后全部是注释/文档里的溯源引用（「ports from v2 …」）
> 与 CHANGELOG 历史条目，没有可执行依赖。另有 `node_modules/@moonshot-ai/` 下 6 个指向已删除包的
> **悬空软链**（`agent-core-v2`、`kap-server`、`klient`、`acp-server`、`kimi-native-tools`、
> `migration-legacy`），重新 `bun install` 即可清掉。

原盘点如下：

```
消费方包路径                     引用点数量    主要耦合内容与解耦策略
packages/kap-server            175 处       耦合：DI 容器（IInstantiationService）、服务标识符、Workspace 实例。
                                            策略：kap-server 切流为纯轻量代理（直接转发 Rust REST/WS），或直接由 kimi-agent 二进制替代。
packages/klient                122 处       耦合：依赖 v2 内部服务契约接口、状态实体与错误类。
                                            策略：klient 改造为面向 Rust 原生 REST/WebSocket/NAPI 的纯契约 SDK。
packages/node-sdk              42 处        耦合：引用 v2 导出的公开接口定义。
                                            策略：将核心协议类型下沉至 packages/protocol，不再跨包依赖 v2 引擎。
apps/kimi-code                 17 处        耦合：CLI 启动时包装 loopService 并通过 engineOverride 调入 Rust。
                                            策略：P157 实现 CLI 启动器直通 Rust NAPI，彻底废弃 loopService。
packages/acp-server            14 处        耦合：ACP 宿主服务启动器。
                                            策略：流量全面切至 kimi-agent::acp 原生处理，废弃 TS 适配层。
```

---

## 4. 决战路线图：从「双轨并存」到「v2 彻底删除」（P157–P162，**全部已完成**）

> **状态（2026-09-14 复核）**：P157–P162 六步全部落地，`packages/agent-core-v2` 已物理删除。
> 下述各节保留原始措辞作为历史记录；**不要**再按「待执行」阅读。
> 终态门禁 `scripts/check-no-legacy-engine.mjs` 已接入 CI lint job。

```
  ┌─────────────────────────┐     ┌─────────────────────────┐     ┌─────────────────────────┐
  │ P157: CLI 启动直通 Rust  │ ──► │ P158: kap-server 切换原生 │ ──► │ P159: klient 原生门面改造 │
  └─────────────────────────┘     └─────────────────────────┘     └─────────────────────────┘
                                                                               │
  ┌─────────────────────────┐     ┌─────────────────────────┐                  ▼
  │ P162: 物理删除 v2 目录  │ ◄── │ P161: 构建工程与 CI 解绑 │ ◄── ┌─────────────────────────┐
  └─────────────────────────┘     └─────────────────────────┘     │ P160: 废弃 acp-server    │
                                                                  └─────────────────────────┘
```

### P157 — CLI 启动流直通 Rust NAPI（切断 loopService 外壳）
- `apps/kimi-code` 启动入口跳过 `agent-core-v2` 的 `loopService` 实例化，直接由 `rust-loop.ts` 或 NAPI 绑定接管会话 Turn 生命周期；
- 补齐冷恢复逻辑：实现进程重启后子代理从 SQLite 记录自动反序列化恢复（对齐 #3478）；
- 消除 `apps/kimi-code` 对 `agent-core-v2/src/agent/loop` 的编译时与运行时依赖。

### P158 — `kap-server` 彻底物理退役与 Rust 原生服务层全量接管（已完成）
- `apps/kimi-code`（`kimi web`）与周边套件完全直连 `kimi-agent-cli --serve` 原生 HTTP/WebSocket 服务；
- 安全凭据轮转（`rotateServerToken`）与实例存活探活（`getLiveServerInstance`）收敛至 CLI 内聚安全实现；
- 物理删除 `packages/kap-server`，从 workspace 与 `flake.nix` 解除绑定，并纳入 `scripts/check-no-legacy-engine.mjs` 退役黑名单。

### P159 — `klient` 门面原生化改造
- `packages/klient` 全面改造为与 Rust 原生协议（REST/WebSocket 或进程内内存通道）交互的轻量客户端；
- 移除对 v2 内部 DI 容器和实体类型的硬绑定，解开 122 处引用。

### P160 — 废弃 `packages/acp-server`
- ACP 流量完全由 `kimi-agent::acp` 原生处理，弃用 Node 端的过渡适配层（消除 14 处引用）。

### P161 — 解绑构建工程与 CI 门禁
- 将剩余 42 处 `node-sdk` 类型定义迁移收敛至 `packages/protocol`；
- 从根目录 `package.json` 的 `workspaces` 和 `flake.nix` 中移除 `agent-core-v2`；
- 将 CI 门禁中的 `check:engine-zero-js-loop` 升级为 `check:no-legacy-engine` 终态检查。

### P162 — 终态交付：彻底物理删除 `packages/agent-core-v2`
- 执行 `rm -rf packages/agent-core-v2`；
- 确保全仓 `bun run build`、`cargo test` 与各端功能全绿，宣告 Rust 原生引擎主权大获全胜。

---

## 5. 上游 0.42.0 合并遗留的 v2 行为移植队列（2026-09-12）

本次将上游 `@moonshot-ai/kimi-code@0.42.0`（`0.40.1 → 0.42.0`，85 个提交）并入 `main`。上游把 53 个提交集中在 `packages/agent-core-v2`，而该包在本 fork 已物理删除，因此这些行为按「合并时保持删除、行为移植到 Rust」处理，TS 侧一律取 fork 版本以保证 `bun run typecheck` 全绿。参考：`git log 0.40.1..@moonshot-ai/kimi-code@0.42.0 -- packages/agent-core-v2`。

| 上游项 | 上游 v2 行为 | Rust 移植目标 | 状态 |
|---|---|---|---|
| #3524 NotifyUser / Updates panel | 新增 NotifyUser 工具与主/子代理分页进度面板；宿主声明 `HostUiCapability` / `TUI_HOST_UI_CAPABILITIES` | `kimi-agent` 新增 NotifyUser 工具与 `update_panel` 事件；CLI 侧恢复 host UI capability 透传 | **已完成**：`src/tools/core_tool_defs.rs` 与 `tools/mod.rs` 新增 `NotifyUser` 原生工具，`builder.rs` 新增 `NOTIFY_USER_GUIDANCE` |
| #3594 Remote Control 运行时开关 API | kap-server 路由 + `@moonshot-ai/remote-control` manager | Rust server 暴露 remote-control runtime toggle，与 fork 的 CLI 实现对齐 | **仅 REST 表面（2026-09-13 修正）**：`server/mod.rs` 挂载了 `GET/POST /api/v1/remote-control`，但**没有任何运行时实现**（无设备注册、无通道、无心跳）。此前 POST 会把本地状态改成 `state:"on"` 并回一个 `https://code-rc.kimi.com/devices/<随机id>/` URL，客户端据此展示为「已开启」，实际没有任何监听方。现已修正为：GET 回 `enabled:false` + `available:false` + `reason`，POST 返 501（`REMOTE_CONTROL_UNAVAILABLE`），不再伪造状态。**2026-09-16 后续已补真运行时**（`server/remote_control.rs`：设备注册、relay WebSocket 通道、反向 HTTP 代理、心跳；POST 需调用方传入 Kimi login refresh_token——standalone 服务器自己不持有，GET 在未启动时回 `available:false` + 可操作的 reason）。该行 2026-09-13 的「仍是缺失项」结论由此作废。 |
| #3630 会话删除与串行清理 | `deleteSession`、`event.session.deleted` 广播、`ISessionManager.onWillDeleteSession` | Rust server 会话删除端点 + 事件广播 | **已完成**：`server/mod.rs` 支持 `POST /api/v1/sessions/:id:delete`，`event.session.deleted` 携带 `workspaceId` |
| #3548 保留媒体附件名 | 媒体引用新增 `name` 字段 | Rust 原生媒体块类型增加 name 并全链路透传 | **已完成**：`ContentBlock`、`ImageUrl` 等全类型透传 `name: Option<String>`，服务端全链路映射 |
| #3652 / #3649 HEIC/HEIF/BMP 图片 | Kimi 模型接受 HEIC/HEIF/BMP（含首轮默认模型门控） | `native/image_compress.rs` + 媒体 mime 白名单 | **已完成**：BMP 编解码支持，`src/tools/read_media.rs` 针对 Kimi 模型放行 BMP/HEIC/HEIF 并放宽至 5MB 预算（路径于 2026-09-15 更正：该文件在 `src/tools/`，不在 `src/native/`） |
| #3537 compaction 恢复锚定最新用户消息 | 自动压缩后恢复正确请求 | `compaction/mod.rs` 恢复锚点 | **已完成**：实现 `compaction_continuation_message`，LLM 前压缩与紧急压缩均注入恢复锚点 |
| #3645 大文件读取可续读 | 可恢复长行读取与重复截断修复 | `src/tools/mod.rs`（活体 Read） | **已完成（2026-09-19 更正路径）**：`Read` 工具增加 `column_offset` 与 `max_chars` 限制，超限提示断点续读参数——实现在 `src/tools/mod.rs:1876-1893`（活体工具），不在 `native/read.rs`（napi 历史接口无这两个参数） |
| #3658 glob 超过 100 条 | 分页续取 | `src/tools/core_tool_defs.rs` + `src/tools/mod.rs` | **已完成**：`Glob` 工具增加 `head_limit` 和 `offset`，支持分页切片与续取提示（`tools/mod.rs:1843,1954-1995`）。2026-09-15 更正：此处原先写作 `native/glob.rs`，那是模式匹配辅助，不是该工具实现 |
| #3654 MCP 结构化结果去重 | 保留不同的结构化结果 | `mcp/*` | **已完成**：`McpToolCallResult` 新增 `structuredContent` 与 `_meta`，在 `<mcp-result-extras>` 保留完整数据 |
| #3624 LLM retry/recovery 从 llm machine 移到 turn state machine | 重试状态机归位 | `turn_loop/retry.rs` 与 turn 状态机 | **已归位（措辞修正）**：`turn_step.rs` / `run_turn.rs` 自主驱动重试循环。原条目只写「已在…自主驱动」而无证据，保留为已归位。 |
| #3502 统一 fs watch 为单一 xstate 服务 | 文件监听统一 | ~~`kimi-agent/src/server/fs_watch.rs`~~ **已删除** | ❌ **已按上游回退（2026-09-20）**：该行原记「已接线（mtime 轮询实现）」——**记错了方向**。#3502 是上游**删除**行为：它把 `watch_fs_add` / `watch_fs_remove` / `event.fs.changed` 这套 WS 面从 v1 协议里移除（同提交删掉 `docs/en/reference/server-api.md` 的那一行），改为 v2 引擎内部 `human/utils/watch.ts`（xstate 服务，**无 wire 面**）。fork 在删除之后重新实现了旧接口，且全仓无消费者（dist-web 0 命中、无 TS 客户端发送）。已整批移除：`fs_watch.rs`（251 行 + 3 测试）、`ws_protocol.rs` 的 `WatchFsAdd`/`WatchFsRemove`、`ws.rs` 的 `WatchRegistry` 与两个分支、`mod.rs`/`http.rs`/`main.rs` 接线、`packages/protocol/src/ws-control.ts` 的 schema 与 operation 注册、测试用例。详见 §7.3。 |
| #3644 交互 DI → 全局 human 单例 | interaction 层归并 | `permission` / `callbacks` / interaction | 原生已收敛至 `interaction::InteractionManager` |
| #3638 遥测事件属性丢失修复 | 停止静默丢弃 key event attributes | telemetry 桥接 | 原生已由 `events.rs` 保持全属性无损 |
| #3616 云推荐 thinking effort | 默认 effort 升级为推荐档 | 已有 `recommended-effort`（CLI 侧），核对引擎参数透传 | CLI 与引擎参数无损透传 |

**本次合并中整包/整文件回退到 fork 版本（上游改动转上表）**：
- `packages/kap-server`：已彻底物理删除（见 P158）。
- `apps/vis`：整包回退（调试工具，上游 #3540 对齐改动待后续单独处理）。
- `apps/kimi-code` 引擎耦合文件：`constant/app.ts`、`cli/sub/web/{run,remote-control}.ts`、`tui/commands/{web,btw,plugins}.ts`、`utils/paths.ts` 等。
- `packages/node-sdk` 上游 v2 表面文件已移除：`flag.ts`、`image.ts`、`interaction.ts`、`mcp.ts`、`permission.ts`、`replay.ts`、`task.ts`、`tool.ts`、`model-provider.ts`、`config/resolve.ts`、`logging/*`、`utils/fs.ts`。

> 该队列不阻塞本次 merge；按 Rust 子系统逐条落地并补 `cargo test` 断言。

### 未闭环项（2026-09-14 复核后重写）

> 前一版（2026-09-13）在此列了 4 项，其中 2 项已在当日晚间的修复批次中解决，且第 2 项的描述本身失实。
> 以下为**逐条回源码复核**后的当前状态。

1. ~~#3594 remote-control 的原生服务端运行时~~ **已解决（2026-09-14）**。
   `server/remote_control.rs`（1422 行；2026-09-19 复核，原写 1339、后改 1317）是原生实现：设备注册、到 `code-rc.kimi.com` 的 WebSocket 中继
   （`tokio-tungstenite`）、心跳与有界指数退避重连、反向 HTTP 代理，由 `server/mod.rs` 持有
   `RemoteControlHandle` 并在 `/api/v1/remote-control` 上暴露真实状态（不再是 `enabled:false` 的诚实占位）。
   TS CLI 那条路径（`apps/kimi-code/src/cli/sub/web/remote-control.ts`）仍在，`kimi rc` /
   `kimi web --remote-control` 走它；两条路径现在都能提供服务。

2. ~~#3502 fs watch 语义~~ **已按上游回退（2026-09-20）**。本条目历史上有两次相反的记录，现予结论性更正：本节曾写「原生有 `fs_watch.rs` 单一通道」——当时该文件并不存在；2026-09-14 又补上了 `server/fs_watch.rs`（mtime 轮询，`event.fs.changed` 发到会话 lane）并接线。**两次都判错了上游**：#3502（`3f967e1410`）正是**删除**该 WS 面的提交——它把 `watch_fs_add`/`watch_fs_remove`/`event.fs.changed` 从 v1 协议移除，改为 v2 引擎内部 `human/utils/watch.ts`（无 wire 面）。fork 的实现是在上游删除之后重建的旧接口，无任何仓内消费者，已整批删除。详见 §7.3。

3. ~~`POST /api/v1/acp` 桥~~ **已解决（2026-09-14 复核）**。该端点现按 `self.engine` 是否存在选择
   `AcpServer::with_shared_engine`（`server/mod.rs:2406-2435`），不再是无 engine 的断头桥；
   `session/new|load|resume|fork` 已可用。**不设 notification sink 是刻意的**并在代码中写明：
   纯 HTTP 请求/响应没有服务端推送 `session/update` 的通道，最终结果仍在 JSON-RPC 响应里返回；
   需要推送的消费方走 stdio ACP 入口（`acp/mod.rs` 会 `set_notification_sink`）。
   附注：`acp/mod.rs` 早期在无 engine 时会伪造一份助手回复并 `save_turn` 落库，该行为**已删除**
   （全 crate 已无 `Response to:` 之类的伪造文本）。

4. ~~**`apps/vis` 整包回退**（上游 #3540 对齐）——仍待单独处理，见第 5 节末尾的「整包/整文件回退」清单。~~
   **已解决（2026-09-14）**：`452302a2b7 fix(vis): align with upstream #3540 and keep the fork i18n layer`
   已把 #3540 增量重放到 fork 的 i18n 层之上（server：context-memory vendor + projector/task-store/wire-reader/session-store
   对齐 + wire 契约补 `file_history.*` 等字段；web：analysis/各 Tab 对齐 + 全量 `t()` 化 + en/zh 新 key）。
   验证：`apps/vis/server` 18 文件 181 项、`apps/vis/web` 7 文件 43 项测试全绿。

5. ~~**模式互斥（mode mutex）缺失（2026-09-14 域对照新增）**~~ **已落地（2026-09-14，2026-09-22 复核确认标题）**：v2 `agent/modeMutex/modeMutexService.ts`
   在进入 plan/swarm 时自动退出 tower，进入 tower 时自动退出 plan + swarm；Rust 侧 plan/tower/swarm
   三者进入路径之间零互斥逻辑（`plan_mode.rs`、`swarm_tool.rs`、`tools/tower/` 均无交叉退出）。
   后果：plan 激活期间起 tower/swarm（或反之）两边同算 active，tower worker 的写可能撞上 plan guard。
   **已落地（2026-09-14）**：`src/tools/mode_mutex.rs` + dispatch 接线（`tools/mod.rs` 的
   enterplanmode/agentswarm/towerinit 分支）+ 门禁（`tower/mod.rs` 的 spawn-worker 与 merge
   分支拒 paused 任务）。Rust 无 tower/swarm mode flag，互斥按引擎架构表达：plan-enter
   与 swarm-dispatch 暂停开放 tower 任务（`Paused`，不删不 teardown；均限 main agent，
   对齐 v2 的 Agent 作用域）；暂停是实的——TowerSpawn-worker 与 TowerMerge 在 paused
   任务上拒绝并指引恢复；TowerMission status=active 可恢复（main 解析为 tower，
   ownership 放行）；tower-init 成功进入后经 state bridge 退出 plan（`{active:false}`，
   undoable；init 失败/被拒则不退出，对齐 v2「进入事件才退 plan」）。swarm 无持久模式，
   tower-enter 侧无需退出；plan 退出后 tower 不自动恢复（与 v2 粘性一致，需手动 resume）。
   验证：`mode_mutex.rs` 6 项单测 + `tools/mod.rs` `mode_mutex_dispatch` 模块 7 项
   dispatch 集成测试（真实 git 仓库 + 真实 `execute_tool` 分支）全绿。

---

## 6. v2 对齐复核（2026-09-15）与未闭环工单

> 复核方式：把 `upstream/main` 的 v2 源码全量抽出到 `.tmp/v2-ref-upstream/`（本轮 2026-09-19 仍在用；
> 旧引用 `.tmp/v2-ref/` 已改名为 `v2-ref-upstream`，`agent-core-v2` 1,544 /
> `kap-server` 314 / `klient` 94 / `acp-server` 49 文件），把本文件的每一条声明拿回两侧源码核对，
> 而不是接受本文件自己的措辞。结论：**架构与功能面基本对齐，行为语义面存在已证实缺口。**

### 6.0 缺口为什么会静默堆积（已修）

fork 物理删除了四个被替代的包，于是上游改这些包的提交**不冲突、不报错、也没人看见**。
本轮测得：fork 落后 `upstream/main` 29 个提交，其中 **22 个**改了上述包（merge base `6954d2c8bf`）。

已加机械化门禁 `scripts/check-upstream-v2-delta.mjs`（接在 CI `lint` 作业）：列出 merge base
之后所有触及被删除包的提交，要求每一个都在 `scripts/upstream-v2-delta-allowlist.json` 中带有明确
裁定（`ported` / `tracked` / `not-applicable`；`pending` 或未记录即失败）。历史快照（2026-09-17
三次复核，merge base `6954d2c8bf`、上游 `25dd4ce973`）：`ported=21 | tracked=11 |
not-applicable=21`（53 条）。**当前快照（2026-09-21 复核，merge base `1b89e4b039`，
上游 `0523bafb3`）**：`ported=16 | tracked=0 | not-applicable=12`（28 条，全部分类完毕；
此前记的 `ported=4 | tracked=8` 与 `ported=12 | not-applicable=5` 都是更早的过期数字）。
快照数字随 merge base 变化，复核时以 `bun scripts/check-upstream-v2-delta.mjs` 实时输出为准。
**该 ref 推进前（门禁视野之外）复核的 17 个提交见 §6.6；其中 11 个触及被删除包的已连同裁定
写入门禁 allowlist（`roadmap: §6.6`）。**

**2026-09-17 追加发现之二：allowlist 的裁定本身会过期。** `b1807253c3`（#3728 permission_mode 提醒）
的 note 至今写着"the whole permission_mode reminder injection is absent from the fork"，而该实现
2026-09-15 就已落地（`src/injection/permission_mode.rs` + `run_turn.rs:605,731`），裁定已就地更正为
`ported`。⇒ 复核对账时**必须拿代码验证裁定，不能信任 note 的措辞**；每轮复核把 `tracked` 条目逐条
回代码里查一遍，能指出行号的直接改判 `ported`。

**2026-09-17 追加发现：ref 过期会让门禁静默缩小检查范围。** 门禁读的是本地
`refs/remotes/upstream/main`；该 ref 若停在 `ee2cac102b`（09-12），检查区间就只剩 22 条并报
「all triaged」绿灯，而真实区间（`25dd4ce973`，09-17）是 53 条 —— 未分类的 `31f1b6824d`
（#3846）就是这么漏掉的。门禁在 ref **缺失**时会拒绝通过，但 ref **存在而过期**时不会。
因此每次复核前必须显式取一次远端并核对提交号：

```sh
git fetch upstream main:refs/remotes/upstream/main --force
git log -1 --format='%h %cs %s' refs/remotes/upstream/main
```

同时必须记住：`scripts/scan-parity.mjs` 的比对源**全部是 fork 自有声明**
（`packages/protocol/src/rest/*.ts` 注释清单、`ws-event-contract.json`、`tool-name-contract.json`、
`napi-contract.d.ts`、`node-sdk/src/config-local/schema.ts`），它**从不读取 upstream/v2**。
它的绿灯只证明 fork 内部自洽，**不能**当作 v2 对齐的证据。

### 6.1 未闭环工单（按优先级）

1. ~~**`permission_mode` 提醒注入整体缺失（上游 #3728 / v2 `PermissionModeInjection`）**~~ **已解决
   （2026-09-15 后续变更）**。落地为 `src/injection/permission_mode.rs`：两段文案逐字对齐上游
   `permission-mode-auto-enter-reminder.md` / `-exit-reminder.md`，`PermissionModeTracker` 复刻
   `permissionModeInjection.ts` 的转移逻辑（同模式且已注入过则静默；进入 auto 注入 enter；离开 auto
   注入 exit），`scan_permission_mode_baseline` 从历史恢复 v2 的 `permissionMode.lastMode` 与该变体
   自己的 `injectedPositions`（v2 前者在 agent state、后者在历史，fork 两者都从历史扫描），
   `KIMI_CODE_PERMISSION_MODE_REMINDER` 门禁按 v2 `parseBooleanEnv` 语义（仅显式 false 关闭）。
   模式来源是 host 已有的 `PolicySnapshot.mode`：`RunTurnInput.permission_mode` 由
   `EnginePipeline.permission_mode`（napi 两条路径）、`SessionConfig.permission_mode`（stdio/napi
   会话）、`server/engine.rs` 与 REPL 的 policy snapshot 分别填入，**未新增 napi 参数**，因此
   `JsRunTurnParams` / `session-handle.ts` / `apps/kimi-code` 无需改动（SDK 早已把
   `meta.permissionMode` 写进 `policySnapshotJson`，`setPermission` 会重建会话）。
   子代理轮次与 `lib.rs` 的纯原生路径无 policy snapshot，传 `None`（提醒面向主代理的
   AskUserQuestion / ExitPlanMode 交互）。验证：`injection::permission_mode` 8 项单测 +
   `pipeline::tests::pipeline_carries_the_policy_snapshot_mode`（snapshot → pipeline 的映射）+
   `run_turn` 的 `test_permission_mode_reminders_follow_the_mode_transitions`（真实 turn 循环，
   进入 auto → 注入、历史已含提醒 → 不重复、回到 manual → 注入 exit）。
   **已知交互**：host 在 plan 模式下把 snapshot mode 写成 `plan`（引擎读作 `PermissionMode::Unknown`，
   权限链按 manual 处理），因此 auto ↔ plan 切换会各发一次 exit/enter 提醒——这与引擎实际执行的
   权限语义一致，但与 v2（plan 是独立轴、不触碰 permission mode）不同。
2. ~~**#3734 流式 attempt 状态未在重试时失效**~~ **已解决（2026-09-17）**。复核结论：Rust 原本
   **没有**这条路径，但缺的不是"修 bug"而是**整套机制**，故按"缺的补上"落地为三部分：
   ① turn 作用域 id 账本 `src/turn_loop/tool_call_id.rs`（逐字移植 v2 `ToolCallIdNormalizer`：`seed_from`
   一次性从历史认领、`begin_response`、`remap_streamed_id`（带稳定 stream slot）、`remap_finalized_ids`、
   `rollback`、`remapped` 原始→分配映射）；② **流式 tool-call 增量原本整条线不存在**（`EngineEvent::ToolCallDelta`
   有消费者没有生产者），本次补上生产者：`StreamDelta::ToolCall`（`src/llm/wire.rs`）由 openai
   `tool_calls[i].function.arguments` 分片（`openai.rs:434`）、anthropic `input_json_delta`（`anthropic.rs:570`）、
   openai-responses `response.function_call_arguments.delta`（`openai_responses.rs:316`）产出；google-genai
   以整块 `args` 返回，故本就不产生分片。`Accumulator::take_tool_call_deltas`（`http.rs:52`）取出，
   `NativeHttpLlm::emit_delta`（`http.rs:214`）在出口对分片 id 归一化，收尾时对进入历史的调用做同一套映射，
   使**分片与最终调用同 id**；宿主侧 v3 live 把 `tool_call` part 映射为 `ServerMessage::ToolCallDelta`
   （`server/v3/live.rs:376`），不再被误投影成空的 assistant delta（ws v1 / transcript / REPL / ACP 的类型守卫
   对本 part 类型无副作用）。③ 失败即作废：`AttemptLedger`（`http.rs:909`）每次请求开一份
   （`http.rs:390-393`），**任何失败出口经 `Drop` 回滚本 attempt 的认领**，仅成功时 `commit`（`http.rs:573`）——
   对应 v2 `onAttemptRetry` 的语义（v2 的"请求层重试"在本引擎即"每次 `chat_impl` 开一份 attempt"）。
   账本由 turn 安装到传输层（`run_turn.rs:768-776` → `LLM::set_tool_call_ids`，`http.rs:947`）。
   **已知差异**：v2 会把原始 id 盖到调用上（`ToolCall.rawId`）以便按 provider 策略回映射；本引擎没有该策略
   （历史与 provider 拿到的都是分配后的 id），故 raw→assigned 只留在账本的 `remapped` 列表里——
   为不存在的消费者给 `ToolCall` 加字段会波及 193 处字面量。provider 尚未给出 id 的分片**不外发**
   （`http.rs:214`）：空 id 由 step 的 P61 兜底生成，先发一个空 id 的实体永远无法与最终调用合流。
   验证：`src/llm/http.rs` 新增 3 项（分片/最终同 id、失败释放、账本 commit/rollback）+ `tool_call_id` 12 项
   单测（对齐 v2 `toolCallIdNormalizer.test.ts`）。
3. ~~**#3694 存储失败重建索引 / #3648 tower 可靠性**：已在 allowlist 记为 `tracked`，但尚未逐条与 Rust 实现比对，需要单独一轮 triage。~~
   **已 triage（2026-09-18）**。#3694 **不适用**：上游修的是「派生索引」（会话索引镜像 + 搜索索引）在不可恢复存储失败后的重建；fork 引擎的 SQLite 是唯一事实源，搜索是对 messages 表的实时查询，没有任何派生镜像需要重建。#3648 **已全部落地（唤醒半件 2026-09-19 补齐）**：幂等 teardown（git 已不知道的 worktree 报告 already-removed 而非整体失败，`tower/git.rs` `worktree_remove`，2 项测试）、「分支仅剩 closed 记录时拒绝 merge」门禁（`tower/store.rs` merge 前置检查，1 项测试）、roster resume 的前台否决（`agent_tool.rs` `tower_resume_denial`，`14b6600bfe`，P2-2 补 toolset 根）均已落地；**唤醒合并通知**亦已落地（2026-09-19）：worker 向 tower（或广播）发送后，`execute_tower_send` 经共享 TaskRunner 注入合成通知（`enqueue_wake`，同一 task id 在队列中**原位合并**——一批消息一条唤醒；过 liveness 门、发 `event.task.completed`/`background.task.terminated` 双词汇事件），主会话 pump 把它排成后续回合；`TowerTeardown` 经 `cancel_wake` 丢弃排队唤醒（v2 exit-drop 语义）。渲染对 wake 特判（不伪装成「后台任务完成」）。测试：`tower_wake_coalesces_into_one_notification_per_batch`、`tower_wake_is_scoped_and_cancelable`（task_runner）、`worker_tower_send_wakes_the_main_session`（真实 git 仓库 + 双 toolset dispatch）。
   （原列的 #3681 `[models]` 告警已落地，见第 14 条；#3720 / #3717 已拆出，见第 15 条；
   #3606 模型目录运行时已落地，见第 16 条；**#3697 与 #3688 已从本条移出并落地**，见 §6.2。）
4. ~~**#3532 v3 扁平实体消息协议（WS + history API）——已决定全量移植（2026-09-15）**~~ **已整体撤销（2026-09-21，见 §8.11）**：上游用
   **2026-09-21 裁定变更**：上游在 2.0.2 已 revert 该协议（`2502d2157`），理由见 §8.11；
   fork 同步撤销（`86f30ecc2c`）。本条以下全部「已完成」表述均为**撤销前**的历史记录，
   仅作审计留痕，**不代表现存代码**——现存协议面只有 v1。上游用
   `transport/ws/` 下的 `v1`/`v3`/`debug` 三代并存命名，v3 即「扁平实体」代际（提交
   `64505e36e3`，design revision 1094）：26 个 server 消息变体 + 2 个 client 帧，实体按
   `agent_id:type:entity_id` 寻址，live WS 与 history 服务同一套消息形状。本 fork 的 kap-server
   副本停在 #3532 之前（退役前 `transport/ws/` 下只有 `v1`），随后整包退役，因此 v3 从未进入 fork；
   `apps/kimi-inspect` 也停在旧协议（缺 `src/transcript/channel.ts` 与 `plan.ts`）。
   上游该提交量级：kap-server 84 文件 / +15,852 / −2,215，另加 kimi-inspect 客户端整轮重写。
   **落地分期**：P0 Rust 契约层**已完成**（`44b56ee1bc`、`b558dae248`）——
   `src/server/v3/entity.rs`（id 探针顺序与 `entity_key`）、`messages.rs`（26 个 server 变体 +
   2 个 client 帧，按 `type` 内部标签解析，可选字段按上游语义写出而非写成 null）、
   `v3-message-contract.json`（冻结上游快照：commit、design revision 1094、逐变体字段），以及
   `scripts/scan-parity.mjs` 的 v3 维度（双向 + 变体级/字段级；本地存在上游抽取时再对上游复核，
   CI 跳过该段）→ P1 历史 → 扁平实体投影（turn/step/user/assistant/thinking/tool_call 投影函数已完成；
   **todo/task 已接入（2026-09-19 本轮补齐）**：history 路由与 v3 恢复页经
   `project_state_domains` 把工作区状态域（todo 列表 + 本会话后台任务，任务条目带 `sessionId`
   过滤）追加到页尾——上游从 coldFold 的 TodoList 工具调用/任务记录推导，fork 的权威源是
   工作区状态存储；live 侧经 `event.state.changed`（`StateStoreCallbacks::state_write` 发出，
   对应上游 `IAgentTodoService.onDidChange` 订阅）折成 `todo`/`task` 实体；
   `agent_state` 与 `interaction` 无历史源、`session_state` 只有部分来源，
   见下）→ P2 按 turn 分页的 history 路由**已完成**（`GET /api/v1/sessions/{id}/history`：turn
   边界整页、默认 50/上限 200、`before_turn`/`after_step` 互斥、错误码 40001/40401；该路由**始终**
   回信封——上游如此，而 v1 客户端根本不会调它——但错误带真实 HTTP 状态，上游则恒回 200 只靠 `code`
   表达失败。`in_flight` 暂不返回：实时侧还没按同一规则生成 step 字符串，给出错误的位置会让客户端把
   后续增量接到错的 step 上）→
   P3 与 v1 并存的 `/api/v3/ws`（实时翻译器**已完成**：`src/server/v3/live.rs` 把引擎事件折成 v3
   实体，实体 id 与历史投影同源。两个此引擎特有的事实决定了它的形状：**流式帧不带 step**——`assistant.delta`／
   `thinking.delta` 只有 turn 和 delta，所以 step 只存在于读的人脑里，翻译器替它记住：turn 开始后或工具轮次
   结束后出现的第一段文本开新 step，工具调用开始时关闭当前 step（与历史「每个 assistant 消息一个 step」
   一致）；**词汇里有两种 turn id**——`turn.*`/`assistant.delta`/`tool.call.*` 用活动追踪器的数字计数，
   `llm.*` 用字符串，实体序号只取数字那个，`llm.*` 仅用于开 step，其自带序号不作实体序号（历史按位置编号，
   两者必须一致）。已知限制：该计数与存储位置在压缩/回退移除 turn 后不再一致；`tool.progress` 的载荷没有
   约定形状，故按 `custom` 原样携带而不拆成它可能没有的字段；`subagent.message` 属于子代理自己的时间线；
   `config.changed`/`session.meta.updated`/`cron.fired`/goal 预算通知属全局或宿主态。**端点已完成**
   （`src/server/ws_v3.rs`，与 v1 并存）：一次连接一个 hub 订阅，按会话分发到各自的翻译器；`hello` 先发，
   每个 `subscribe` 先回 `ack` 再回**恢复页**（就是历史路由会给出的那批实体，客户端等于从一页它本可自取的
   位置续上），随后才是实时实体。两个细节让交接正确而非仅仅有序：**游标先读、订阅后挂**（其间发布的事件
   落在订阅缓冲里，而游标及以下的都已在恢复页中，车道直接丢弃而不是追加第二遍）；**恢复页也过订阅过滤器**
   （点名了一个 agent 就不该因为库里存着而收到另一个 agent 的时间线）。帧语义照上游：JSON 语法错是 40002，
   未知/非法帧是 40001 并点名类型，会话不存在在 ack 里按 id 回 40401，心跳漏两次 pong 即断开。编解码器
   （`read_frame`/`write_frame`/`FrameReader`/操作码常量）放开到 `pub(crate)`，两代协议共用一份。
   本端点的留白（上游有、本 fork 暂无生产者）：**2026-09-19 本轮补齐一部分**——全局 lane 的
   `config.changed` / `config.warning` / `model_catalog.changed` 已按连接折叠为全局实体并送达所有
   订阅者（`ws_v3::Connection::translate_global`，对应上游 `GlobalMessageTranslator`）；实时 turn 的
   `usage` 已由 `v3/live.rs` `turn_usage` 捕获（3ed130924e）。仍缺：`workspace`/`plugin`/`capability`
   事件无生产者、慢消费者尚未用 `WS_SLOW_CONSUMER 42903` 回告；`in_flight` 仍未接入历史路由）→
   **2026-09-19 第二轮补齐**：慢消费者回告已实现——hub 把溢出槽标记为 `STATE_OVERFLOW`，
   连接经 watch 感知后先发 `42903` 错误帧（走不受限控制通道，绕开已满的出站队列）再以 1013 关闭
   （`ws_v3` 溢出臂 + `hub.rs` `state_rx`/`closed()`；测试 `a_slow_consumer_gets_the_42903_error_frame_before_the_close`）；
   `in_flight` 已接入 history 路由——`ServerEngine.in_flight` 注册表由每回合
   `MessageCallbacks::with_step_tracker` 在 `llm.step.begin` 更新、回合结束清除，路由响应带出
   与 live 增量同一套 turn/step 实体 id（测试 `v3_history_route_reports_the_live_streaming_position`）；
   **第三轮（同日）**：`event.plugin.changed` 已有生产者——插件 install/enable/disable/remove
   路由成功后经 `publish_plugin_changed()` 全局发布，v3 折叠为 `plugin` bare-bump 实体
   （测试 `a_plugin_mutation_publishes_the_plugin_entity_to_v3_clients`）。
   仍缺：`workspace`/`capability` 事件无生产者——workspace 实体要等 fork 实现工作区生命周期变更，
   capability 在引擎侧是 ACP initialize 的**静态**清单、没有变更语义可广播（结构性留白，非缺口））→
   P4 客户端（kimi-inspect、kimi-web、`apps/kimi-code` 的
   `web` 子命令；TUI/stdio 走 NAPI，不在内。另需在 `packages/protocol` 补 v3 实体联合类型与
   `HistoryResponse`：当前只有端点声明行，没有可供客户端导入的类型）。
   **2026-09-15 可行性核查（决定数据源）**：生产路径的 `wire_events` 只写
   `message.user`/`message.assistant`/`tool.result`/`subagent.message` 与 compaction 检查点
   （`lib.rs`、`subagent/persistent.rs`、`native/event_store`）——`turn.started`、`step.begin`、
   `content.part`、`tool.call` 这些词表项全部只存在于测试夹具中。因此投影**不以 wire_events 为
   唯一来源**，而与现有冷重建同源：`server/mod.rs:3621` 起取 `LLMMessage` 历史交给
   `transcript::build_items`，且 `paginate_turns`/`TurnPageQuery` 已实现按 turn 分页。实体来源：
   `messages`（含 `blocks` → thinking）、`turns`（turn_number/status/usage）、
   `state_entries`（goal/plan/task/todo → `agent_state`/`task`/`todo`）、sessions/workspaces/
   session_file_history → session/workspace/step-usage 实体。
   **2026-09-15 实体 id 决策（P1）**：实时流与存储**不共享 turn id**——实时 `turn.started` 带
   `turnId: u64`（`server/activity.rs` 的 `AgentPhase`；其 `stepId` 字符串恒为 `String::new()`，
   且每个工具轮次推进一次 step 计数），而 `turns.turn_id` 是 `server/engine.rs:1038` 的
   `turn-{随机数}`。因此 v3 实体 id 一律由两路都具备的输入推导，定义集中在
   `src/server/v3/projection.rs`：turn → `{turn_number}`、user → `{n}.user`、
   step → `{n}.{step}`、assistant/thinking → `{n}.{step}.assistant|thinking`、
   tool_call → provider 自己的 `tool_call_id`。序号取「保留历史中的位置」，压缩或回退之后与存储的
   `turn_number` 计数器不同，已在模块文档写明；实时侧（P3）必须按同一规则生成 step 字符串。
   **2026-09-15 状态域投影（P1 续）**：`todo` 忠实可折——fork 存的是树（`parentId`/`kind`/
   `progress`），上游 item 只有 `{title,status}`，故按深度优先展平并丢弃上游无处安放的字段；声明父项
   不在列表中的条目按顶层处理而不消失，`parentId` 成环的条目由兜底扫描按文件顺序补发（此状态来自磁盘，
   无人校验）。`task` 的存储条目是 v2 形状（`taskId`/`description`/`status`/`startedAt`/`endedAt`/
   `stopReason`）：其中 `kind` 只有 live 事件携带、`detached` 无字段（该域全是后台任务），历史侧
   分别固定为 `other`/`true`；`output_tail` 依赖调用方像 `StateStore::read_state` 那样合入
   `read_task_output` 的预览（域里刻意不含 output 日志）；未知状态读作 `lost` 而非 `failed`。
   **无历史源/部分有源（P2 需决策）**：`agent_state` 是纯 live 概念（main/btw/tool-swarm 子代理的
   存活与状态），存储里没有任何对应记录。`session_state` 只有部分来源：`goal`/`modes` 可从 `goal`/
   `plan` 域取，但 `permission` 与 `model` **在 fork 里根本没有落库**（`sessions` 表只有 session_id/
   title/created_at/updated_at/archived/parent_session_id），只能由 live 侧提供。另外 `state_entries`
   表的主键只有 `(domain, key)`、**没有 session_id**，即这些状态域实际是工作区/守护进程级而非会话级，
   会话作用域的 v3 实体如何归属需要在 P2 明确（当前 `todo_id` 取会话 id）。
   **已确认的硬缺口**：schema 中没有 approvals/questions 表（仅有 sessions、turns、messages、
   state_entries、checkpoints、workspaces、session_file_history、wire_events），所以上游的
   `interaction` 实体在 fork 里**只有 live 态**（`server/interaction.rs`），历史折叠无源；要补齐
   必须新增持久化，或明确声明 history 不返回 interaction（客户端需容忍）。
   **2026-09-18 状态更正（P4 客户端）**：本条开头「`apps/kimi-inspect` 也停在旧协议（缺
   `channel.ts`/`plan.ts`）」与 P4 括号里「需在 `packages/protocol` 补 v3 实体联合类型与
   `HistoryResponse`」两处旧表述均已被推翻。kimi-inspect 已迁移 v3（`dc0b534959`）：chat 视图、audit
   面板与 plan 卡改读 `/api/v3/ws` + turn 分页 history 的 v3 实体流，关键文件
   `apps/kimi-inspect/src/transcript/{channel,plan,ws,store}.ts`（`channel.ts` 的 ChatChannel 按
   (session, agent) 持有 store、REST 管线与 socket，每个 ack 后做 `before_turn` 重收与 `after_step`
   追平；`ws.ts` 是 `/api/v3/ws` 客户端；`plan.ts` 从消息流投影 plan 卡）。同提交还给
   `packages/protocol/src/v3.ts` 补上逐变体命名类型（usage/timing/retry、`userMessageOrigin`、
   session_state 的 goal/modes）并经浏览器安全的 `./v3` 子路径导出；实体联合（26 变体）与 history
   契约（10 变体子集 + `v3HistoryResponseSchema`）由同日更早的 `f72d7e644e`/`6c6e141419` 落地——
   协议包这一项随迁完成，不再欠账。P4 剩余项收窄为两类：**kimi-web 与 `apps/kimi-code` `web` 子命令
   所服务的 dist-web 客户端**按 bundle 策略自 code-app 同步，不在本仓以源码接 v3（单列，见根
   AGENTS.md「Web UI」节；实测当前 bundle 未引用 v3 端点）；以及**引擎侧留白**（P3 端点留白清单）：
   实时 turn 的 `usage` 为空、`config.warning` 无来源、慢消费者未接 `WS_SLOW_CONSUMER 42903`、
   `in_flight` 未接历史路由（另有全局 lane 未广播，见 P3）。
   **2026-09-19 本轮更正与补齐**：`usage` 已捕获（`v3/live.rs`，3ed130924e）、`config.warning`
   已有生产者（server/mod.rs `publish_config_warnings`，1774f7007b）且本轮补上全局 lane 折叠、
   history/恢复页接入 todo/task（见第 4 条）——本清单相应条目随之作废；第二轮补齐
   `WS_SLOW_CONSUMER 42903`（溢出槽 watch + 控制通道错误帧）与 `in_flight` 历史路由接入
   （`ServerEngine.in_flight` 注册表 + `MessageCallbacks::with_step_tracker`，见 P3）。
   仍缺的只剩 workspace/plugin/capability 事件生产者。
   验证：`packages/protocol` 562 项、
   `apps/kimi-inspect` 115 项测试全绿（含 v3 store 与协议契约套件）。
5. ~~**ACP 宿主的部分对齐项（板块 8，已就地标注）**~~ **已解决（2026-09-16 后续变更）**。原列七项：
   `stopReason` 非 ACP 枚举（高）、`$/cancel_request` 缺失（中高）、`terminal/kill` 死代码（中）、
   `additionalDirectories` 被静默丢弃（中）、Bash 反向改道 `cwd=None` + 硬编码 shell（高）、
   `session/set_model` 缺失（中）、ACP `mcpServers` 写进程级 manager 与 v2 per-session ephemeral
   语义相反（中）。前六项由本轮 ACP 对齐落地（见 `.changeset/acp-protocol-alignment.md`），
   第七项本次落地：`ServerEngine` 新增 `session_mcp`（`server/engine.rs:239`）与
   `set_session_mcp_manager` / `mcp_manager_for`（`:576,589`），`session/new` 带 `mcpServers` 时
   为该会话新建一个 `McpManager` 并在其上 `configure`（`acp/mod.rs:252`），会话的 pipeline 经
   `mcp_manager_for(session_id)`（`:1015`）取到它；未带该字段的会话仍用进程级 manager。
   **注册即定作用域**：连接失败的服务器照样留在该会话的 roster 上（状态 `failed`），与 v2 把
   `mcpServers` 交给 `sessions.create` 后由引擎连接、失败只影响状态的行为一致。
   验证：`acp::tests::test_acp_new_session_scopes_mcp_servers_to_the_session`（带 `mcpServers` 的
   会话拿到自己的 manager 且共享 manager 不被污染；不带的会话仍 `Arc::ptr_eq` 共享 manager）。
6. ~~**#3787 托管用量配额模型（客户端侧）**~~ **已解决（2026-09-15 后续变更）**。Rust 路由本就是平台
   原样透传（`server/oauth.rs:653-664,698`），本次只补客户端：`packages/oauth/src/managed-usage.ts`
   改为 zod 配额域模型（`managedQuotaEntrySchema`/`managedQuotaUsagesSchema`/`boosterWalletInfoSchema`/
   `managedQuotaSchema`/`managedUsageResultSchema`，`:99-144`），`parseManagedUsagePayload`（`:146`）
   读 `usages.limit_5h|limit_7d|limit_month_total|limit_month_code` 的 `used_ratio`/`reset_time`
   （`parseQuotaUsages` `:156`、`parseQuotaEntry` `:166`，非记录或缺 `used_ratio` 的条目整条丢弃），
   `fetchManagedUsage` 返回 `{kind:'ok', quota}`（`:286`），`toolkit.getManagedUsage` 的
   `AuthManagedUsageResult` 同步为 `{kind:'ok', quota}`（`toolkit.ts:101-106,318-333`）。
   展示层：`apps/kimi-code/src/utils/usage/usage-format.ts` 新增 `quotaUsageRows`（`:95`）按
   「后端给了哪个窗口就渲染哪行」产出 `5h limit`/`Weekly limit`/`Monthly limit` 三行，月度行带
   `monthlyBreakdown`（`:115`，`kimiRatio = monthTotal - monthCode`，两侧都过 `safeUsageRatio`）；
   `usage-panel.ts` 的 `ManagedUsageReport` 改为 `{rows, extraUsage}`（`:49-52`），
   `buildManagedUsageSection`（`:117`）按 `usedRatio` 直接画条并在月度行下补
   `kimi X% · code Y%` 明细行（`:152-161`），`info.ts:263` 用 `quotaUsageRows(res.quota)` 组装。
   **与上游的差异（有意）**：行标签与明细行走 fork 的 i18n（`tui.messages.usagePanel.limit5h` /
   `limitWeekly` / `monthlyLimit` / `monthlyBreakdown`），上游是硬编码英文；`managed-usage.ts` 保留了
   上游本次顺带删掉的两处与本变更无关的注释（base-url 归一化、托管端点严格匹配）。
   验证：`packages/oauth/test/managed-usage.test.ts`（21 项，含新配额 payload、畸形 payload、
   `managedUsageResultSchema`）、`packages/oauth/test/toolkit.test.ts`、
   `apps/kimi-code/test/utils/usage/usage-format.test.ts` 的 `quotaUsageRows` 3 项、
   `apps/kimi-code/test/tui/components/messages/{usage-panel,status-panel}.test.ts`。
   （该债务在 app/oauth 侧，与引擎无关。）
7. ~~**#3785 `[secondary_model].default_effort` 快速失败**：Rust 接受任意字符串
   （`config/mod.rs:1110-1148`），不校验 `support_efforts`/`always_thinking`；上游在池校验处
   拒绝非法值。另缺 catalog 的 `adaptive_thinking` 字段（`server/model_catalog.rs:37-51`）。~~
   **已解决（2026-09-15 后续变更）**。落地为 `KimiConfig::validate_secondary_model_effort`
   （`config/mod.rs:868`，由 `extract_secondary_model_pool` 在池解析成功后调用，`:844`）：
   复刻上游 `assertValidSubagentDefaultEffort` 的三段判定——`off` 对「总是推理」的模型
   （`capabilities` 含 `always_thinking`）报错；`model_supports_effort`（`:1244`）按
   `modelSupportsThinkingEffort(effort, model, true)` 语义（`off` 恒通过、无 thinking 支持恒失败、
   空 `support_efforts` 视为任意档位）；无 thinking 支持与「档位不在列表内」分别给出上游同款文案。
   `model_supports_thinking`（`:1225`）把 fork 的 `capabilities` 字符串（`thinking` /
   `always_thinking`）与 `adaptive_thinking` 一并认作 thinking 支持。catalog 侧
   `ModelItem` 新增 `adaptive_thinking`（`server/model_catalog.rs:54,79`），
   `packages/protocol/src/modelCatalog.ts` 同步该字段。
   **与上游的差异（有意）**：fork 的 `[models.*].capabilities` 是可选的、且 catalog 不派生
   provider-profile 默认值，因此「未声明任何 capabilities 的模型 + 具体档位」在 fork 会被拒
   （上游同样拒，只是上游的 catalog 总能填出 capabilities）。验证：
   `config::tests::test_secondary_model_default_effort_validation`（9 个分支）+
   `server::model_catalog::tests::models_project_the_config_aliases` 的 `adaptive_thinking` 断言。
8. ~~**#3752 tower 名册身份解析**~~ **已解决（2026-09-15 后续变更）**。落地为
   `tools/tower/store.rs`：`resolve_caller_name`（`:338`）改为取同 agent id 的**最后**一条名册记录
   （`.rev().find()`），`register_agent`（`:368`）在追加前先退休同 agent id 的旧条目（重名检查仍在其后，
   被拒的注册不改动已存状态），`is_initialized`（`:68`）改为只把「文件不存在」当作未初始化——非 ENOENT
   的 stat 失败向上传播，`init` 因此不会把不可读的 state.json 当成新工作区覆盖掉（`mode_mutex.rs:46`
   的调用点按「降级为不暂停」处理）。**无 Rust 对应物的上游部分**：`died`/`clearAgentDied` 的
   `findLastIndex`（Rust 名册条目没有死亡字段）、`exit()` 等待所有权释放（`.tower/comms/state.json`
   没有 owner session 概念）、`enter()` 与恢复路径的 adopt 拆分（Rust 只有 TowerInit 一条激活路径，
   它已经经 `init` → `adopt_foreign_roster` 收养工作区名册）。触发条件在 Rust 侧本就潜伏
   （worker id 为随机 `subagent-<u64>`，`subagent/manager.rs:812`），本轮按规则移植。
   验证：`tools::tower::store::tests` 4 项（最后注册优先、注册退休同 id 旧条目、重名仍被拒且不退休、
   `is_initialized` 仅对缺失文件返回 false）。
9. ~~**#3667 动态工具与 MCP 延迟披露**：三部分全缺~~ **已接线（2026-09-18，三件全部就位并接通生产路径）**：
   能力（`server/provider_refresh.rs:83-141`）、每服务器 `deferred` 字段
   （`config/mod.rs:155-198`）、`select_tools` 的广告位（可执行但从未进入
   `tools/tool_policy.rs:128-165` 的工具表；`tools/select_tools.rs:19-26` 明确写着延迟披露
   刻意未实现）。
10. ~~**#3747 提示队列折叠的两个行为差**~~ **已闭环（2026-09-21 复核确认）**：(a) ~~中止已结算提示 Rust 返回 40903~~ **已解决
    （2026-09-15 后续变更）**：`:abort` 路由对不在队列中的提示词改回 40402 `PROMPT_NOT_FOUND`
    （HTTP 404，不再带 `{ aborted: false }`，`server/mod.rs:5497-5505`），Rust 错误码表与
    `packages/protocol` 同步删除 40903 与 `prompt.already_completed`，kimi-web 客户端去掉
    `allowCodes: [40903]`——40402 走它既有的 `PROMPT_NOT_FOUND_CODE` 分支，用户可见行为不变。
    (b) ~~提示图片压缩说明在 Rust 媒体入口完全缺失~~ **已解决（2026-09-20 订正轮）**：
    新增 `src/llm/prompt_media.rs`——v2 `promptMedia.ts` + `image-compress.ts` 的引擎侧半边。
    `prepare_inline_image` 在 `prompt_content_to_blocks` 的 base64 图片分支接线
    （`server/mod.rs` 的 intake）：超限图片经 `image_compress::compress_image`
    （max_edge 2000 / byte_budget 3.75MiB / fallback edges / quality steps，逐值对齐 v2
    `MAX_IMAGE_EDGE_PX` 与 `DEFAULT_INLINE_IMAGE_BYTE_BUDGET`）压缩，原图经
    `persist_original_image` 内容寻址落 FileStore（`f_orig_<sha256>`，复用 store 的去重与
    blob 路径——v2 写 sha256 命名缓存文件，fork 的 store 是同一语义的既有缝），caption 逐字
    对齐 fork 自己的 SDK 版 `buildImageCompressionCaption`
    （`packages/node-sdk/src/media/image-compress.ts:266`，v2 文本 + fork 两处替换：
    `Read` 而非不存在的 `ReadMediaFile`、`, ` 连接变体描述）。解码失败 / 超
    `MAX_IMAGE_DECODE_BYTES` / 已在限内 → 原样透传不 caption（v2 `passthrough`）。
    **未移植（有意）**：v2 intake 的 model-accepted-mime 门——fork 的 #3784 把它移到了
    请求时（解析器发 `<image path>` 标签），模块头已写明。
    验证：`llm::prompt_media` 6 项（caption 逐字、byte size 文案、真实 4000×3000 PNG
    压缩+原图落盘+caption 指路存在、小图透传、坏 bytes 透传）+ intake 层
    `prompt_content_compresses_an_over_budget_inline_image_with_a_caption`。
11. ~~**#3750 压缩尝试上限可配置**：无 `loop_control.compaction_max_attempts` 键；摘要器硬编码
    `RetryConfig::default()` = 10 次（`compaction/mod.rs:308`、`turn_loop/retry.rs:10`），
    上游默认 5 且可配。~~
    **已解决（2026-09-15 后续变更）**。落地为 `LoopControlConfig.compaction_max_attempts`
    （`config/mod.rs:317-321`）+ `KimiConfig::resolve_compaction_max_attempts`（`:936`，上游未给该键
    绑环境变量，故只读文件；schema 下限 1，`0` 视为未设）。摘要器不再硬编码：
    `summarize_with_llm` 新增 `max_attempts` 参数（`compaction/mod.rs:315-320`），
    `CompactionConfig.max_attempts`（`:55`）承载该值并由三个 wrapper 透传，
    `DEFAULT_COMPACTION_MAX_ATTEMPTS = 5`（`:30`）**取上游默认而非 fork 原有的 10**——
    摘要器失败五次后第十次也不会成功，而每次尝试都要重发整段被折叠的前缀。
    宿主侧经 `RunTurnInput.compaction_max_attempts`（`turn_loop/types.rs:852`）→
    `run_turn` 的 `compaction_config.max_attempts`（`turn_loop/run_turn.rs:646`）落地；
    `--serve` 与 REPL 分别由 `with_standalone_limits`（`main.rs:1090`）与
    `SessionConfig.compaction_max_attempts`（`session/mod.rs:184`、`repl/mod.rs:544`）从 config.toml 取值，
    手动 `:compact` 端点复用 `ServerEngine::compaction_max_attempts`（`server/engine.rs:606`）。
    **已知留白**：napi 路径（TUI）没有对应的 napi 参数，`napi_bindings.rs` 传 `None`，
    因此该键在 TUI 下不生效——补它需要同时改 `napi-contract.d.ts` 与 node-sdk 的
    `resolveMaxAttemptsPerStep` 同族解析器，不在本次范围内。验证：
    `config::tests::test_resolve_compaction_max_attempts`、
    `compaction::tests::test_summarizer_honors_the_configured_attempt_cap`、
    `compaction::tests::test_compaction_config_attempt_cap_reaches_the_summarizer`、
    `turn_loop::run_turn::tests::test_compaction_attempt_cap_reaches_the_turn_loop_summarizer`
    （真实 turn 循环 + 真实溢出恢复路径，断言摘要器只被调用 1 次）。
12. ~~**#3749 AI 会话标题**~~ **已解决（2026-09-17）**。开关那一半本就已缺席（fork 原生注册表里没有
    `auto_session_title`，正是毕业后的状态）；它门控的 AI 标题路径现已引擎侧落地。
    新增 `packages/kimi-agent/src/session/title.rs`，对齐 `sessionTitleService` +
    `agentTitlePromptSourceService`：`compose_title_input` 按上游常量组装三种 source 的
    `chat_content`（`first_turn` / `digest` / `user_prompts`，含 digest 的首尾省略），
    `fetch_chat_title` 说 `packages/oauth` 的 `fetchChatTitle` 早已声明的线格式——
    `POST {base}/tools` 带 `{method:'chat_title',params:{chat_content}}`，应答 `{title}`，8 秒超时。
    凭据取自 LLM 的 managed seam（`media_target` + `media_upload_credential`），它按 `auth_provider`
    门控，即引擎侧对应 v2 `modelSource === 'oauth-catalog'` 的标记；静态 API key 的会话对 `digest`
    报具名错误，而不是悄悄退回确定性标题。两个标题入口（`session/generate_title` RPC 与 napi
    `session_generate_title`，后者改为 async）都走 `generate_session_title`；宿主的 source 校验与
    `SessionTitleSource` 接受 `digest`。
    **顺带修掉一个潜伏 panic**：`derive_session_title` 原先按**字节**截断，切在多字节码点中间会 panic
    （CJK 提示词立刻触发）。
    验证：`session::title` 11 项（三种 source 的组装、digest 省略、码点安全截断、managed 门控、
    以及对着 loopback 服务器的真实 HTTP 线格式）。
    **未端到端验证**：成功拿到托管标题需要托管 OAuth 会话，本机没有该凭据。
    allowlist `6126472c7a` 由 `tracked` 改判 `ported`。
13. ~~**#3778 已完成 subagent scope 的 LRU 驱逐**~~ **已解决（2026-09-15 后续变更）**。落地为
    `subagent/manager.rs`：两个环境变量按上游默认值与校验解析（`KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE`
    默认 32、`0`/负数 = 不驱逐；`KIMI_CODE_SUBAGENT_SCOPE_EVICT_TIMEOUT_MS` 默认 15000；非法值让首次
    spawn 直接失败，`:39`/`:58`）；终态实例（Completed/Failed/Terminated，判据是 `subagent/types.rs:115`
    的 `SubagentState::is_terminal`）进入 LRU（`:1781`），超出容量时驱逐最旧完成的**常驻**实例与内存会话
    （`:1801`/`:1854`），持久化的 `subagent_resume` 记录不动，下一次 `resume` 从它重建实例
    （`:1884`，`resume_foreground_turn` 在跑回合前重建，回合结束后重新入 LRU）。**与上游的差异（刻意）**：
    持久实例（`spawn_persistent`，Team/btw 用）不参与驱逐——它们的会话只在内存里，`destroy_persistent`
    仍是唯一移除路径；没挂 `SqliteSessionStore` 的 manager（TUI/NAPI 路径）也不驱逐，因为那里内存历史
    是唯一副本，驱逐会直接破坏 resume。上游的 `closing`/`failed` 驱逐结果没有对应物（Rust 的驱逐是一次
    map 移除，没有可失败的异步 teardown），超时只兜住锁竞争。
    验证：`subagent::manager::tests` 5 项（环境变量校验、非法值让 spawn 失败、驱逐后 resume 重建且
    LRU 顺序正确、无 store 时不驱逐、持久实例不被驱逐）。
14. ~~**#3681 `[models]` 条目缺 `model` 字段时告警**~~ **已解决（2026-09-15 后续变更）**。落地为
    `KimiConfig::malformed_model_entries`（`config/mod.rs:570`），由 `from_file`（`:555`）在真实加载
    路径上逐条 `tracing::warn!`。**引擎没有 config 告警通道**：`packages/protocol/src/events.ts:641`
    声明了 `event.config.warning`、v3 词表也有 `config.warning`，但 Rust 侧两者都**没有生产者**
    （`server/ws_v3.rs:29` 自己写着 "config.warning has no source"），因此按任务约定取最接近的既有机制
    ——引擎日志，而不是新造一条事件通道。判定读**原始 TOML**而非反序列化结果：serde 会丢掉让条目变形的
    嵌套表，也就丢掉了「别名本来是什么」的证据；`dotted_alias_suffix`（`:1280`）复刻上游
    `dottedAliasSuffix`，把未加引号的 `[models.a.b]` 还原成 `[models."a.b"]` 写进提示。
    **与上游的差异**：上游的豁免条件是 `model` 或 `name` 二者之一存在，fork 的 `ModelAliasConfig`
    没有 `name` 字段（`display_name` 是展示名，不构成可解析的模型），故只认 `model`。
    验证：`config::tests::test_malformed_model_entries_warn`（正常条目/带点引号别名不告警、
    缺字段告警、未加引号点号别名给出引号提示、无 `[models]` 表与非法 TOML 均不告警）。
15. ~~**#3720 移除前抑制任务通知 / #3717 拆除后迟到结算静默**~~ **已闭环（2026-09-21 复核确认）**（2026-09-15 后续变更）：
   **通知一半已落地，事件一半仍缺会话存活源**。Rust 的 `TaskRunner` 是**服务级、跨会话共享**的
   （`server/mod.rs:168` 建一次，`:220`/`:238` 分别交给 server 与 subagent manager），而
   `TaskNotification` 原先不带会话、`take_pending_notifications` 整队排空，唯一排空点又是 print/steer
   结算路径（`session/mod.rs:1394`）——于是**一个会话的 print 回合会消费另一个会话的任务完成通知，
   并把它变成自己的后续回合**。落地：`TaskNotification.session_id`（`storage/task_runner.rs:203`，
   结算路径 `:613` 从 `TaskEntry.session_id` 填入）、`take_pending_notifications(session_id)`
   （`:650`）与 `pending_notification_count(session_id)`（`:671`）按会话过滤，
   `SessionConfig.session_id`（`session/mod.rs:214`）→ `SessionContext.session_id`（`:375`，构造
   `:445`）→ 排空点（`:1390`/`:1394`）与「模型是否被欠一个回合」的判据（`:1321`）。宿主 id 由
   `main.rs:426`（stdio）与 `napi_bindings.rs:2028`（napi）填入，REPL 无宿主会话 id 故传 `None`
   （`repl/mod.rs:568`）。
   **`None` 语义（刻意）**：无会话 id 的任务是服务级的，**任何会话作用域的排空都不取它**——把它交给
   「谁先排空谁拿到」正是本次要消除的跨会话泄漏；它留在队列里等服务级消费者。代价：宿主不传
   `session_id` 的 stdio `session/create` 路径（`main.rs:354`，仓内无 TS 调用方）不再有 steer 回合，
   因为该路径的任务同样没有会话归属。
   **事件一半已落地（2026-09-18，`TaskRunner` 存活谓词注入）**：`TaskRunner::set_liveness_check`
   （`storage/task_runner.rs`，与 `set_event_sink` 并列的宿主注入）——谓词 = "该任务的会话还活着吗"，
   `settle_task` 在**通知入队与两个终态事件前各查一次**，会话已死则完全静默（对应 v2
   `recordTaskTerminated` 的 dispatch 门 + `notifyAgentTask` 早退）；状态桥镜像（`persist_wire`）与
   任务条目本身不受影响——任务照常终结、照常可查。**存活源按宿主各自实现**：server 用会话行的存在性
   （`HttpServer::install_task_liveness`，与 prompt 路由 404 门同一个 `get_session` 检查；
   `with_task_runner` 换 runner 时重装），stdio/napi 用**会话句柄本身**——`EngineSession::is_shutdown()`
   （新增，读 pump 的 shutdown 标志）+ 与 `SESSION_REGISTRY` 条目共享所有权的 `Weak`，
   `session_dispose` 摘条目即 `Weak` 失效（v2 `isAgentActive` 的 identity 语义对应物）。
   谓词未注入 = 永远存活（旧行为），REPL 等未接线宿主不受影响。测试：
   `settle_stays_silent_when_the_host_reports_the_session_dead`、`liveness_gate_is_per_session`（spawn
   期事实不受门控——只有结算路径被门）、`without_a_liveness_predicate_the_settle_path_keeps_firing`、
   `late_settle_for_a_deleted_session_stays_silent`（server 级：活会话照常广播+入队，已删会话静默）。
   验证：`storage::task_runner::tests::notifications_are_scoped_to_the_settling_tasks_session`、
   `storage::task_runner::tests::unattributed_notifications_are_never_drained_by_a_session`、
   `session::tests::test_print_steer_ignores_another_sessions_notifications`（真实 print 结算路径：
   两个会话各有一条待排空通知，steer 回合只带本会话的 `t-mine`，`t-other` 不进入提示词且仍留在队列里）、
   `session::tests::test_print_steer_feeds_task_notifications_back`（本会话的完成照常 steer）。
16. ~~**#3606 模型目录运行时重接 + 移除逐模型检视面板**~~ **已解决（2026-09-15 后续变更）**。
    上游把目录运行时接到 provider-catalog 状态机，并**删掉**了逐模型检视（`IModelCatalog.inspect`
    与 496 行 `inspection.ts`），换成 ping + 建会话动作。fork 的
    `apps/kimi-inspect/src/components/ModelCatalogView.tsx:368,522` 仍在调 `IModelCatalog.inspect`，
    而 Rust 调试面**不服务该方法**（`server/debug.rs` 的 `modelCatalog` 只有
    `listModels`/`listProviders`），所以该面板当时是坏的。本次落地：
    **调试面三个新方法**——`modelCatalog.ping`（`server/debug.rs:669` 调度 → `ping_model`
    `:70`，经 `ServerEngine::llm_for_model`（`server/engine.rs:921`）复用 turn 的 LLM 选择链
    （`resolved_native_llm` + `build_llm_for_spec`），发一条 `"ping"` 用户消息、空工具表，
    回 `{ok, durationMs, text, finishReason, usage}` 或 provider 自己的错误文本；模型解析不到
    provider 时回 `ok:false` 并点名模型，**不伪造 pong**）、`modelService.list`
    （`:684` → `model_records` `:122`，按 alias id 投影 `[models.*]` 原始记录，`providerId`
    取 alias 的 provider 或全局 `default_provider`，**不投影 apiKey**）、
    `sessionManager.resume`（`:597`，standalone 服务端没有可实例化的 per-session 运行时——
    会话作用域路由一律按需读库——故「resume」= 会话存在且可达；未知会话回 400 错误而非静默成功，
    404 在本面保留给「未知方法」）。三者均已登记进 `describe_all_channels()`
    （`:184,189,197`）与描述符/调度一致性测试的 `dispatched` 表（`:1080,1082,1083`）。
    **顺带对齐**：`modelCatalog.listProviders` 原先返回 `{id,name,type,base_url,oauth}`，
    与 fork 自己的 `compat/v2.ts` 声明（`ProviderCatalogItem` 的 `status`/`default_model`/
    `has_api_key`/`models`）不符，导致移植后的 provider 状态徽章与 default 标记、以及
    `Sidebar.resolveDefaultModel`（`Sidebar.tsx:108-114`）都读不到值；现改为复用 REST 侧已有的
    `model_catalog::providers`（`server/model_catalog.rs:141`）。
    **视图移植**：`apps/kimi-inspect/src/components/ModelCatalogView.tsx`（608 → 381 行）换成上游
    413 行版本的三栏→两栏形态（左列表 + 每模型 Ping / + Session 动作），纯分组与上下文长度标签
    抽到 `src/components/modelCatalog.ts`（`groupModelsByProvider` `:25`、`formatContextSize`
    `:51`，配 `modelCatalog.test.ts` 5 项），全部用户可见文案走 `t()`
    （`src/i18n/locales/{en,zh}.ts` 新增 `modelCatalog` 命名空间 20 键），
    `compat/v2.ts` 删掉已无人调用的 `IModelCatalog.inspect` 与 `ModelInspection`/
    `InspectionSource` 声明（正是它们让坏调用看起来合法）。文档同步：
    `apps/kimi-inspect/AGENTS.md` 与 `README.md` 的 Model Catalog 段落。
    验证：`server::debug::tests::debug_model_records_and_session_resume_are_real`、
    `debug_model_ping_never_fakes_a_pong`、`debug_channel_descriptor_matches_dispatch`、
    `server::engine::tests::llm_for_model_resolves_a_named_alias_and_refuses_an_unknown_one`；
    `cd apps/kimi-inspect && bun run test` 115 项全绿、`bun run typecheck` 干净。
17. ~~**#3784 图片以文件引用上传 + 媒体请求预算**~~ **已解决（2026-09-16 后续变更）**。
    **先说基础错误**：本条原先的落地是照着一份**过期参照**写的。`.tmp/v2-ref` 的抽取时间是
    2026-09-12 01:27，而 `upstream/main` 是 `5653c739b9`（2026-09-15 21:32），晚 32 个提交，
    其中就有本条要移植的 `5653c739b9 feat(agent-core-v2): upload images as file references for
    Kimi models (#3784)`。三条硬证据：过期树里 `human/llm-kimi/files.ts` 只有 `uploadVideo`
    （`uploadImage` 是 #3784 带进来的）；过期树里 `agent/media/mediaResolverService.ts` 中
    `"media budget"` 命中 0 次（上游版本有 `REQUEST_MEDIA_BUDGET_BYTES` /
    `REQUEST_MEDIA_BUDGET_LOW_BYTES` / `mediaBudgetDroppedKey`）；原条目声称预算常量「逐字对齐上游」
    并引用 `KimiFiles.uploadImage`，两者在写作时所依据的那棵树里都不存在。`.tmp/v2-ref` 已重新抽取，
    旧树留在 `.tmp/v2-ref-2026-09-12`。

    **真正的结构错误**：媒体身份在 host 边界被销毁。原 `media_block_from_bytes`
    （`server/mod.rs:785`）把字节 base64 编码进 `ContentBlock::Image { media_type, data, name }`，
    `fileId` 与 path 就在那一行丢掉，下游再也拿不回来。v2 相反：消息里存的是**引用**
    （`image_url.url = "kimi-file://<fileId>"`），到请求时才由 `AgentMediaResolverService.resolve()`
    解析成内联 base64、provider 侧 `ms://<id>`、或 `<image path="…">` 标签。原条目里被写成
    「引擎结构所限，非疏漏」的每一条差异，都是这一个原因的派生——补症状是错的，所以本轮重建了引用模型。

    **落地**：
    - **协议**：`ContentBlock::MediaRef { file_id, kind }`（`rpc/types.rs:451`）与 `MediaKind`
      （`:444`）。三种状态由此显式：内联（`Image`）、引用（`MediaRef`）、已解析的远端
      （`ImageUrl`/`VideoUrl`/`AudioUrl`）。`ImageUrl` 补上 `id`（`:487`），openai 投影带上
      `image_url.id`（`llm/openai.rs:147`），anthropic 与 v2 一致不带（`llm/anthropic.rs:229`）。
    - **host 边界**：`file_ref_from_store`（`server/mod.rs:785`）与 `path` 分支不再读字节，改发
      `MediaRef`；`path` 来源先 `FileStore::save` 落库再引用（v2 的「materialize the session copy」）。
      非媒体类型（PDF 等）仍走 `[Attached file: …]` 文本占位。客户端提交的 `kimi-file://<id>` URL 由
      `normalize_media_refs`（`llm/media_resolver.rs:120`）在 napi `session_enqueue_turn`
      （`napi_bindings.rs:2112`）与 HTTP `prompt_content_to_blocks`（`server/mod.rs:1046`）两处入口
      转成引用——**此前这类 URL 会被原样发给 provider**（napi 路径）或**被静默丢弃**（HTTP 路径
      不认 `image_url` 部件）。
    - **解析器**：`src/llm/media_resolver.rs`，对齐 `AgentMediaResolverService`。读 `file_id` →
      `FileStore::get` 取元数据与 blob 路径 → 模型不接受该媒体族时给 `<image path="…">` 标签
      （`build_media_path_tag`，属性转义对齐 v2 `escapeMediaAttribute`）→ 否则读字节、按
      `MediaTarget` 决定上传或内联；blob 丢失时给 v2 的
      `[image|video|audio omitted: the uploaded file is no longer available]`。解析结果按
      `(fileId, providerKey)` 记忆（v2 `media.resolved`）。
    - **provider 侧上传**：`src/llm/files_upload.rs`。`POST {base}/files` multipart
      （`purpose=image|video`），multipart 体手写——daemon 接收侧本来就是手写解析
      （`server/files.rs:321`），两侧保持对称，不引入 `reqwest` 的 `multipart` feature。
      `files_base_url` 实现 v2 `kimiFilesBaseUrl`（anthropic 路由补回被剥掉的 `/v1`）；凭据复用
      `NativeHttpLlm::credential()`（OAuth 刷新走既有单飞通道），经 `LLM::media_upload_credential`
      （`turn_loop/types.rs:99`）暴露。门与 v2 的 `modelSource === 'oauth-catalog'` 对齐：
      `NativeLlmConfig.auth_provider.is_some()`。错误分类对齐 v2：401/403 → `Auth`（降级为路径标签，
      真正的鉴权错误由随后的 chat 请求报出）、404/405/501 → `Unsupported`（记住该 provider 不再尝试，
      v2 `imageUploadUnsupported`）、其余 → 内联兜底。
    - **预算**：`src/llm/media_budget.rs` 重写。key 改为**引用用 fileId、内联用
      `inline\0<sha256(kind\0payload)>`**（v2 `inlineMediaBudgetEntry`）；被丢弃的引用替换为
      `<image path="…">` 标签（路径未知时给 unavailable 文案），内联仍用
      `[image|video omitted: dropped to fit the request media budget]`；告警按 v2 补上从句——
      全部被丢弃项都有 fileId 时结尾是 ` and remain available at their saved paths.`，否则是 `.`；
      零字节项（provider 侧引用）跳过不丢。**跨 turn 粘滞**：`MediaBudget::shared` 写穿到调用方的
      `DroppedMedia`（`Arc<Mutex<HashSet<String>>>`），`ServerEngine.media_dropped` 按会话持有
      （`server/engine.rs:243`），生命周期与 v2 的 agent state 一致（进程内，不落库）。
    - **接入点**：turn loop 每次 LLM 调用前（`run_turn.rs:893` 正常步、`:967` 紧急压缩重试步），
      `budgeted_request` 先解析再计预算，告警仍走 `WarningEvent` 通道。

    **验证**：`llm::media_resolver` 13 项（内联/路径标签/blob 丢失/借用快路径/内联计费/远程 URL 不计/
      记忆/属性转义/URL 解析与归一化/上传得引用/无凭据内联）、`llm::media_budget` 10 项（含零字节项
      不丢、引用丢弃留路径、粘滞种子）、`llm::files_upload` 6 项（anthropic `/v1`、multipart 体与二进制
      载荷、文件名、响应 id、状态分类）、`turn_loop::run_turn::tests::
      test_over_budget_media_are_omitted_from_the_request_and_warned_about`（真实 turn 循环）、
      `server::tests::prompt_content_maps_uploaded_files_to_media_blocks`（host 边界发引用）、
      `acp::tests::test_acp_new_session_scopes_mcp_servers_to_the_session`。全量
      `cargo test --no-default-features --features cli,workflow-js` 2488 项通过（`bash` 需解析到
      Git Bash；PATH 上是 WSL 时 `tools::tests::bash_streams_output_chunks_to_the_progress_callback`
      会因 WSL 的 localhost 代理告警失败，与本轮无关），`bun scripts/scan-parity.mjs` 通过。

    **与上游仍存的差异**（本轮未消除，均为可观测行为差异）：
    ① **上传缓存不落库**。v2 把 fileId 写进 blob store 的 `image-upload-cache` scope，重启后仍复用；
    fork 只在解析器的进程内记忆里缓存，重启后首次请求会重新上传。要补齐需把 `SqliteSessionStore`
    接进解析器（`state_entries` 的 domain 可复用）。
    ② **`displayPaths` 未接到 UI**。解析器已暴露 `MediaResolver::display_path`（`media_resolver.rs:262`），
    但 v2 用它喂 context projector 的媒体降级路径（`mediaProjection.ts` 的 `degradeOlderMediaParts` /
    `stripMediaPartsBySnapshot`），fork 没有这套降级，也没有把「引用 → 保存路径」映射送到 TUI 的协议面。
    ③ ~~**上传鉴权失败降级而非抛出**~~ **已解决（2026-09-20 订正轮）**：`upload` 改返
    `Result<Option<ContentBlock>, UploadError>`，`Auth` 分支经 `resolve_uncached` →
    `resolve_one` → `resolve` → `budgeted_request`（`run_turn.rs`）一路 `?` 上传，
    回合以该错误失败（v2 `mediaResolverService.ts:356` 的 `throw error` 语义）；
    `UploadError` 补 `Display`/`Error`。`Unsupported`（记住并停止尝试）与 `Other`
    （内联兜底）行为不变。验证：`test_a_rejected_upload_credential_fails_the_resolve`
    （401 mock → resolve 失败且错误含 401）+ 全量 2744 项。
    ④ **预算只覆盖 image/video/audio 的内联形态**，与 v2 的 image/video 一致（audio 在 v2 不计，
    fork 把 audio 的 data URL 也计入了——这是 fork 多出的一项，不是缺失）。

18. ~~**#3838 取消操作把 AbortError 抛成进程崩溃（live 包，未移植）**~~ **已解决（2026-09-17）**。
    `packages/telemetry/src/crash.ts` 的 sole-listener 分支改为 `if (soleListener && !isAbortError(reason))`，
    并补上上游那段 AbortError 注释；该文件现与 `upstream/main` **逐字一致**（`git diff --no-index` 空）。
    另一半（agent-core-v2 的 xstate2 abort 管线）无 Rust 对应物，不移植。
    验证：`telemetry.test.ts` 新增 `does not rethrow an aborted-operation rejection when it is the only listener`
    （清空 vitest 自己的 listener 让 crash handler 成为唯一 listener，断言 AbortError 既不上报也不 rethrow，
    返回 `NOT_CAUGHT` 哨兵）；allowlist `f4e5822164` 由 `tracked` 改判 `ported`。

19. ~~**#3764 prompt / skill-activation 的 client metadata 与 display_text（未移植）**~~ **已落地（2026-09-18，宿主侧通道）**。上游在 prompt 与
    skill activation 的 origin 上存一个不透明 metadata 对象，随 prompt 事件、transcript 投影、snapshot 与
    history 重建一路携带，并在「每个 entry 都提供」时用 `display_text` 生成会话标题、undo 标签与 fork 标题；
    该 metadata 不进模型内容。fork 现状：`rg "display_text|client_metadata|clientMetadata" packages/kimi-agent/src`
    为空，标题派生只读 prompt 正文（`packages/node-sdk/src/native/sdk-rpc-client-native.ts`
    的 `promptMetadataTextFromPrompt`），没有 metadata 通道。**验收**：RunTurnInput → origin → history
    能携带并回显该对象，宿主提供的 `display_text` 优先决定标题（allowlist: `41eac5d2e7`）。

20. ~~**#3840 Windows 8.3 短路径的 watch 归一化（未移植）**~~ **不适用（2026-09-17 复核）**。
    上游的缺陷是 libuv 专属的：变更通知按长路径到达，而 watch root 以 8.3 形式注册，于是 libuv
    `fs-event.c` 断言 `!_wcsnicmp(filename, dir, dirlen)` 直接终止进程。fork 的
    `packages/kimi-agent/src/server/fs_watch.rs` 是**定时轮询** `tokio::fs::metadata`，没有 OS watcher、
    没有 libuv，该断言不可达。上游修复的两个行为面 fork 本就满足：事件按注册时的路径原样回显
    （正是上游要映射回去的结果），且 8.3 路径解析到同一文件——本机实测
    `C:/Users/ADMINI~1/.kimi-code/mcp.json` 与 `C:/Users/Administrator/.kimi-code/mcp.json` 的 inode
    （281474977003976）与 mtime（1789609827）完全一致，轮询两种写法看到同一个 mtime。
    该提交的后续修复（`..cache` 这类以两点开头的子项算作 root 内）同样不适用：fork 不比较相对路径。
    allowlist `9c5e9b4863` 由 `tracked` 改判 `not-applicable`。

21. ~~**#3832 被 steer 的用户 slash skill activation 未记录（TS 侧 + 引擎侧）**~~ **已落地（2026-09-18，宿主侧 steer 语义）**。上游
    `packages/transcript/src/contract/{origin,schema}.ts` 增加 `skill_activation` origin 变体
    （trigger user-slash + skillName + skillArgs），fork 仍是只有 `user` 变体
    （`rg "skill_activation" packages/transcript/src/contract/` 为空，该包停在合并时的上游 0.0.2）。
    当前仓内无任何包 import `@moonshot-ai/transcript`，因此尚不可见；Rust 引擎投影自己的 origin
    （`server/transcript/model.rs:81` `UserOriginKind`、`:308` `TranscriptUserOrigin`），
    被 steer 的 slash activation 也要进到那里。**验收**：TS 契约随上游合并落地，且引擎 origin 投影
    覆盖 steer 路径的 skill activation（allowlist: `1c7e996aa8`）。

22. **#3911 压缩前预收缩摘要请求历史（已落地 2026-09-19）**：`compaction/mod.rs` 新增
    `summarize_with_llm_budgeted` + `pre_shrink_to_window_budget` / `take_recent_within_budget`
    （安全比 0.85 = v2 `OVERFLOW_CONTEXT_SAFETY_RATIO`，输出预留 = 窗口/8，扣除请求自身估算，
    保留最近尾部且不落悬空 tool result；什么都放不下时返回空切片、调用方按 v2 语义发送原样）。
    `run_turn` 的溢出恢复经 `force_compact_messages_with_summary_budgeted` 传入
    `max_context_tokens`。3 条单测钉住放得下不发、尾部存活、无悬空 tool result（allowlist:
    `88a7d932f1`）。

23. **#3910 openrouter reasoning 方言的 thinking 恢复（已落地重放半件 2026-09-19）**：
    `openai.rs::project_message` 接收 `reasoning_key`（`[models.<alias>].reasoning_key`，
    `http.rs` 透传），声明了 key 的模型把 Think 块放回该字段重放，而不是压平成 assistant 文本；
    未声明的保持文本兜底。回归测试钉住两种形状。**未移植**：v2 的 `reasoning_details` 数组
    think-part 盖戳（`reasoningKey`/`detailsIndex`）——fork 的 `ContentBlock::Think` 没有
    detailsIndex 身份，机械移植会对引擎已重放字段二次重放；现有形状下字符串与 details 共存时
    字符串本来就被保留（allowlist: `7dc253c5ce`）。

24. **#3909 目录项暴露 resolved base_url（已落地 2026-09-19，就地）**：fork 的目录是内置
    静态列表而非 models.dev 代理，但 base_url 字段已按 v2 的 item 形状补上（每项解析出的
    端点）；per-id 路由改为与列表路由共用同一份数据源，未知 id 返回 404 而不是伪造占位条目
    （v2 的 per-id 路由同样只回真实条目）。server-api.md 双语文档同步。models.dev 代理面
    （抓取 + 缓存 + 快照回退）仍未建，属独立工单（allowlist: `92c3c59b22`）。

25. **#3907 评分问卷携带 turn trace id 与 copilot 统计（已落地 2026-09-19）**：引擎在
    `turn_ended` 遥测载荷补 `trace_id`（引擎侧铸造 `turn-<id>`；provider request id 仍不可见，
    `wire-schema.ts` 注释保留——一个稳定的引擎级每轮 id 已满足问卷归因），协议
    `TurnEndedEvent` 新增可选 `traceId`（`events.ts` 接口 + zod schema），napi 桥透传
    `trace_id`；TUI 侧 `surveyController` 记录 `pendingTraceId` 并在载荷新增 `kfc_trace_id`、
    `subagent_count`、`subagent_models`、`swarm_run_count`、`swarm_models`（模型清单来自
    AgentSwarm/Swarm 调用族，普通子代理只有计数——事件载荷尚无 model 字段）。tower 遥测
    `tower_mode_enter/exit` 在 SDK `setTowerMode` 的翻转点发出（flag 本就在宿主侧，引擎没有
    可观察的翻转点）。（allowlist: `3cc6b2a330`）

26. **#3906 单次 steer 复用排队 prompt id（已落地 2026-09-19）**：`LLMMessage` 新增可选
    `prompt_id`（持久化为 `messages.prompt_id` 列，沿用 store 的幂等 ALTER 迁移模式），
    `ServerEngine::enqueue_steer` 在调用方未带 id 时铸造，REST `prompt_ids` steer 路由复用
    排队 prompt 自己的 id（v2 `children[0].waiter.id`）；v3 投影把带 id 的 steer 消息留在
    当前回合内、实体 id 即 prompt id、`origin.inTurn = true`（v2 `markInTurnOrigin`），
    不再自铸回合——取消时同文本出现两次、宿主 prompt 无法 undo 的两个症状同时消除；
    live 翻译器对 `message.user` 应用同一规则，实体 id 与历史投影一致。
    `#3891` 的保留消息 id 配对随本项落地：客户端按 prompt id 配对 steered follow-up，
    不再按内容匹配（allowlist: `60f2a63278`、`53e5e3fca6`）。

    关于 v2 该修复的两个症状，fork 侧的实际情况经实测确认一半：
    - 「宿主 prompt 无法 undo」**在 fork 上本不存在**。v2 的修法实质是 `isUndoAnchorOrigin`
      排除 in-turn 消息，让 steer 与其宿主 prompt 落进同一个 undo 单元；fork 没有
      `is_undo_anchor`，但 undo 是**回合作用域**（`DELETE FROM messages WHERE turn_id = ?`），
      而 steer 复用 active turn_id，所以两者天然同属一个 undo 单元 —— 该 bug 的形态在 fork
      上不成立，因此未移植 `isUndoAnchorOrigin` 判定（移植也不会改变行为）。
      该不变量由 `sqlite_store.rs` 的 `a_steer_and_its_host_prompt_are_one_undo_unit`
      实测钉住；若将来 undo 改成消息作用域，该测试会先失败，避免静默回归。
    - 「取消时同文本出现两次」随 prompt id 移植消除（v3 投影与 live 翻译器均按 id 分组）。

    即：本项移植的实际价值是让**投影正确分组**（in-turn origin + 实体 id 复用），undo 症状
    只是 fork 既有作用域的巧合结果，不应被误读为照搬 v2 的 undo 锚点逻辑。

27. **#3897 swarm/tower/外部钩子/remote-control 用量遥测（已落地 2026-09-19，余塔进入点）**：
    `swarm_mode_entered/exited` 在 `apply_prompt_submission_options`（模式翻转时发，重复写不发）；
    `external_hook_resolved` 在 `HookGuard::denial`（`action`/`matched_count`/`failed_count`，
    失败按 `TIMED_OUT`/`ERRORED` 前缀分类，verdict 逻辑零改动）；`remote_control_toggle` 在
    REST 路由（`outcome: ok/already_running/error`，与 v2
    `kap-server/src/routes/remoteControl.ts:84-105` 一致）。缝合方式：钩子事件经
    `HookGuard::with_telemetry`（`OnceLock`，防重复安装）落到 `HostCallbacks::telemetry`——
    napi / stdio 宿主已在读取的通道；服务端路由无宿主回调，经 `HttpServer::emit_session_telemetry`
    发出，无 sink 时落 `tracing::info`（standalone `--serve` 没有可上报的上游遥测服务，日志是
    始终可观察的兜底，`with_telemetry_sink` 留给宿主集成）。`tower_mode_enter/exit` 在 SDK
    `setTowerMode` 的翻转点发出（`sdk-rpc-client-native.ts:2411`）——tower flag 本就在宿主侧
    （引擎只经参数接收启用状态），所以发射点只能在 SDK，引擎侧没有可观察的翻转点可挂。
    （allowlist: `b0d0a80c32`）。

28. **#3878 Agent 工具宣传不变量 + Read 媒体错误文案（已落地 2026-09-19）**：两半——
    (1) v2 的 Agent 工具曾宣传子代理注册表中并不存在的工具名；fork 的
    `profile_tools_listing` 从同一策略源构建宣传表与执行门控，但「宣传 == 可执行」这条
    不变量**没有测试钉住**，已补 `every_advertised_builtin_tool_is_resolvable`
    （`tools/agent_tool.rs`）：每个内建 profile 宣传的非通配名都必须
    `is_native_tool_name` 命中，且通过自身的 `ToolPolicyFilter` 门控。
    (2) Read 媒体错误文案已对照 v2 逐条比对：三条限额文案
    （`delivery_limit_error` / `decode_limit_error` / `full_resolution_limit_error`）
    与 v2 `buildImageDeliveryLimitError` / `buildImageDecodeLimitError` /
    `buildFullResolutionLimitError` **逐字一致**，仅工具名是 `Read` 而非 `ReadMediaFile`
    ——fork 没有独立媒体工具，媒体走 `Read` 本身（`tool-name-contract.json`），故正确。
    capability 门控的拒绝文案已按 v2 命名文件类型与缺失的 `image_in`/`video_in`
    capability。`ReadMediaFile` 指针变体不适用。（allowlist: `f233f9de04`）

    另：2026-09-19 批量 triage 后确认两条 not-applicable 无需动作——#3892（洪水根目录观察
    崩溃）依赖 v2 的 OS 目录 watcher，fork 的 fs_watch 是注册路径的 mtime 轮询，无此失败
    模式；#3887（会话删除挂死）的三处无界等待都在 v2 生命周期链内部，fork 的 delete 路由
    无 settle await 可卡，且压缩取消后 apply 前的取消检查 `summarize_with_llm` 已有；
    #3889（大工作区 resume 性能）优化的 wire-restore/immer/kap-server 缓存层 fork 不存在，
    恢复是直连 SQLite 读（allowlist: `a80fe31cff`、`e3f48a225b`、`5108cad9b6`）。

9. ~~**server 路径取消回合时丢弃未 drain 的 steer 消息（2026-09-21 复核 #3933 发现）~~ **已落地（2026-09-21）**：
   `ServerEngine` 的 steer 队列原先随回合消亡（`ActiveGuard::drop` 无条件移除
   `steer_queues[session]`），而 `run_turn` 的取消检查在 step 顶部、**早于** `drain_steers`
   （`turn_loop/run_turn.rs:859` vs `:874`）——steer 在取消前一刻入队即被静默丢弃，用户看到
   `prompt.steered` 之后文本消失；session 路径（`session/mod.rs:430` 的会话级队列）同场景下
   消息进入下一回合，与 v2「未消费 steer 种子下一回合」（`loopService.ts:1079-1090`、
   `850-864`）语义一致的是后者，两条宿主路径行为不一致。修法（对齐 session 路径，不引入
   v2 的种子回合机制）：`ActiveGuard::drop` 改调 `ServerEngine::release_turn_steer_state`——
   非空队列**存活过回合边界**，由下一回合的 `SteerQueueCallbacks` 在首个 step 头部 drain
   （消息自带 `prompt_id`，转录里只出现一次）；空队列照旧移除，map 不随会话数增长；
   signal 槽仍每轮刷新。测试：`an_undrained_steer_survives_the_turn_boundary_for_the_next_turn`
   （存活 + 下一回合可 drain + 无活跃回合时 `enqueue_steer` 仍拒绝）、
   `an_empty_steer_queue_is_dropped_at_the_turn_boundary`（空队列不泄漏），以及**真实路径**
   `a_steer_survives_a_cancel_and_joins_the_next_turn_over_rest`（REST 路由 → 真实引擎 →
   本地 mock OpenAI SSE：首请求挂起、steer 入队、`:abort`、下一 prompt 的回合在首个 step
   头部取走该消息；断言 steered 文本在全库恰好出现一次且属于取消后的新回合——已临时还原旧
   行为验证该测试确实变红）。

30. ~~**v2 `observeContextOverflow` 的有效窗口学习未移植（2026-09-22 深查发现）~~ **已解决（2026-09-22）**：v2 在
    `fullCompactionService` 内按 `modelAlias` 维护 `observedMaxContextTokensByModel`
    （`defineState` 持久化），观测到溢出时把有效窗口降为 `floor(estimated × 0.85)`
    （只降不升，`getEffectiveMaxContextTokens = min(configured, observed)`），使后续请求与
    压缩触发改用更保守的窗口。已移植：`compaction` 模块的进程内观测缓存（按模型名键——
    真实窗口是模型/供应商的属性，跨会话共享比 v2 的按会话更正确），`observe_context_overflow` /
    `effective_max_tokens` 逐字对应 v2 两个方法（含“只降不升”守卫与“无配置窗时观测值独立成立”
    分支）；调用点按 v2 原样放在**压缩请求自身溢出**的恢复分支里（`summarize_with_llm_budgeted`，
    与 `observeContextOverflow` 在 fullCompactionService catch 中的位置一致），回合级的
    `should_recover` 门与预收缩预算改用 `effective_max_tokens(model, configured)`。
    **记录的差异**：v2 经 `defineState` 持久化，fork 为进程内缓存——重启后重新学习
    （引擎本就是进程内对象，会话级状态在宿主 SQLite）。allowlist 无需改动（该项不在门禁
    区间内，属深查发现）。

31. ~~**LLM 计时埋点整体缺失（2026-09-22 审计 #3938 重新定性）~~ **已解决（2026-09-22）**：v2 逐步记录
    `llmFirstTokenLatencyMs` / `llmStreamDurationMs`（#3938 起冷折叠步骤也带 timing/usage）。
    fork 引擎原先**没有任何 LLM 计时埋点**——全树唯一的 `StepTiming` 是
    `server/transcript/model.rs:270` 的定义，从未被填充（projector 以 `timing: None`
    建步骤，`LlmStepEnd` 只带 turn_id/step/usage）。已完整移植：新增 `llm/timing.rs`
    （`LlmTiming`，v2 `ModelRequestTiming` 的 6 字段），native HTTP transport 在
    `chat_impl` 打 4 个时间戳（started/sent/首个 SSE 事件/流结束）按 v2 公式计算
    （`serverDecodeMs`/`clientConsumeMs` 留 None——fork 的 SSE reader 不产 decode stats）；
    timing 经 `LLMChatResponse` → `StepResult` → turn 循环每步发射的
    `llm.step.end`（带 turn_id/step/usage/timing）→ projector 折叠进步骤
    （`StepTiming` 自此被真实填充）。host-proxy 路径报 `None`（宿主拥有该调用）。
    allowlist 已改判 `ported`。

32. **文件监视模块缺失（2026-09-22 审计 #3931 / #3892 重新定性）**：上游在 #3502 删除
    watch 的 WS 面之后**保留了引擎内部 watch**（#3931 把默认关掉、#3892 限制根扫描）；
    fork 当时把 `fs_watch` 整批移除（ROADMAP §7.3），比上游走得更远——现在引擎侧
    **没有任何文件监视**，`[watch] enabled` / `KIMI_CODE_WATCH` 两个旋钮也无对应物。
    原裁定记“不适用”，实为**模块缺失**（且是 fork 主动删过的模块，恢复属“取消删除”
    类决策）。当前无消费者，记为已接受债务；将来移植从“默认关”起。allowlist 已改判 `tracked`。

33. ~~**tower 记录用量遥测缺失（2026-09-22 审计 #3847(b) 重新定性）~~ **已解决（2026-09-22）**：v2 的 tower 记录（finding/review/send）
    带 `tokens` = 调用方累计用量（`callerTokens` = `grandTotal`，四维求和）。
    `SubagentManager` 原无按实例累计（foreground/background/persistent 三条完成路径均只写
    会话历史）。已补：`usage_by_instance` 计数器在三个回合完成点折叠，
    `caller_tokens` 按 v2 `grandTotal`（input + cacheRead + cacheCreation + output）
    上报；tower 三个写入方把 tokens 带进记录（finding 的 `**Tokens**` 行、
    review/inbox 的 frontmatter 字段，`read_inbox` 往返解析）。**记录在案的分歧**：
    main 调用方报 `None`（v2 的 -1）——会话总量在宿主 SQLite turn 记录里，
    toolset 不可达；subagent 调用方（tower 记录的实际提交者）完整覆盖。
    allowlist 已改判 `ported`。

### 6.2 本轮已修复（含证据）

| 上游 | 修复 | 证据 |
|---|---|---|
| #3714 `rm -rf` 仅 `/tmp`、`/temp` 免审 | `RM_SAFE_TEMP_ROOTS` + `is_safe_temp_rm_operand` + `rm` 操作数收集（`--` 之后全为操作数），并把上游 `literalText` 的 `UNSAFE_OPERAND` 字面量判据折叠进操作数检查 | `src/native/permission_engine/dangerous_command.rs`；新增 `test_rm_rf_temp_paths_are_exempt`（7 个免审用例）与 `test_rm_rf_outside_temp_paths_stay_dangerous`（9 个危险用例） |
| #3657 移除 wall-clock 时间预算上限 | 删除 `MAX_REASONABLE_TIME_BUDGET_MS`，只校验 `>= 1s` 且有限；工具描述逐字对齐上游 `set-goal-budget.md:15-17` | `src/goal/mod.rs`、`src/tools/goal_tools.rs`；新增 `test_set_budget_accepts_durations_above_the_former_24h_ceiling`，`storage/state_store.rs` 改为断言亚秒预算被拒 |
| #3734 重试时作废已流式的 attempt 状态 | 见 §6.1 第 2 条：补上 v2 的整套机制——turn 作用域 id 账本（`src/turn_loop/tool_call_id.rs`）、**流式 tool-call 增量生产者**（`src/llm/wire.rs` 的 `StreamDelta::ToolCall`；openai/anthropic/responses 三协议产出，google 无分片）、出口 id 归一化（`src/llm/http.rs:214`）、失败即回滚的 attempt 守卫（`src/llm/http.rs:909`，`Drop` 回滚、成功才 `commit`）、v3 宿主映射（`src/server/v3/live.rs:376`） | `streamed_tool_call_fragments_share_the_finalized_id`、`failed_request_releases_the_tool_call_ids_it_streamed`、`attempt_ledger_commits_or_releases`（`src/llm/http.rs`）；`src/turn_loop/tool_call_id.rs` 12 项 |
| #3688 MCP 结果里的媒体被压成文本预览、原件不留存 | 新增 `src/mcp/output.rs`（`convertMCPContentBlock` + `mcpResultToExecutableOutput` 的移植）：文本/图片/音频/视频/resource/resource_link 逐类映射，内联媒体先落库再交付；`FileStore::save_with_id`（内容寻址 `f_mcp_<sha256>`，幂等去重）与 `blob_path`、`resolve_attachment_reference`（`src/server/files.rs:90,226,316`）；原件以 `kimi-file://<id>` 引用 + 本地路径写进通知（v2 原文），媒体本体以 `ContentBlock::MediaRef` 走 `ToolDelivery`，由请求解析器按模型能力内联；超过 10MB 的单块/无对应家族的 resource blob **不交付但仍留存**；通知超 4096 字符则把清单本身存成附件并换成指针；转换逐块响应取消探测。`tools/mod.rs:1527` 先尝试按附件引用解析路径，使 `Read`/`ReadMediaFile` 能打开通知里给的原件 | `src/mcp/output.rs` 8 项、`src/server/files.rs` 2 项、`src/mcp/manager.rs` 的 `test_mcp_media_is_preserved_and_delivered_as_a_reference`（新增 `image` mock 模式） |
| #3697 steer 打断后台等待的**前置件**：`WaitFor` 在生产路径上根本不阻塞 | triage 先证伪了上游前提——引擎把 `WaitFor` 摊成**同步**的 `StateStore::task_wait`（`src/storage/state_store.rs:703`，其注释自承"REPL 尚无后台任务 runner"），而所有引擎路径都经 `StateStoreCallbacks`（`src/pipeline/mod.rs:273`、`src/server/engine.rs:939`）到达它：5 秒等待在 6ms 内返回 `timed_out`（迁移前用真实生产链探针实测）。**没有阻塞就无从打断**，故先补阻塞：`NativeToolset::execute_tool_streaming` 把自己持有的 `task_runner`（即 spawn 后台 Bash/Agent 的那个 runner）传进 `execute_task_wait`，`TaskRunner::wait_interruptible` 真挂起在任务的 `done` 上；状态桥保留为**本 runner 不认识的任务**的宿主兜底（服务端每轮重建 pipeline，上一轮的任务属另一个 runner）。顺带补上 fork 缺失的 **wait-any**：`task_id` 变可选（v2 `WaitForInputSchema`）、`TaskRunner::wait_any`、`no_tasks` 报告、以及 v2 的 `[still_running]` 尾段 | `src/storage/task_runner.rs`（`wait_interruptible`/`wait_any`/`TaskWaitResult::Interrupted`）、`src/tools/task_tools.rs`（`execute_task_wait` 的 runner 路由 + `render_wait_no_tasks`/`push_still_running`）；6 项 runner 单测 + 8 项 tool 单测；探针实测 1009ms/1000ms（迁移前 6ms）、完成唤醒 169ms |
| #3697 steer 打断后台等待（v2 `steerController`） | 在阻塞等待之上落地：`ParentCancel` 槽与 P55 取消槽并列，穿过 `NativeToolset`/`PipelineHost`/`SessionConfig`；会话 pump 每轮发布新信号（服务端按 session 发布），**在 steer 真正并入轮次处触发**（`session::admit_locked` 的 ActiveOrNewTurn 分支、`ServerEngine::enqueue_steer`），并在轮次取走 steer 时刷新（`SteerQueueCallbacks::drain_steers`），对应 v2"不再有未丢弃 steer 时重建 `steerController`"；空 drain 不刷新。`WaitFor` 据此渲染 v2 的 `formatInterrupted`（`wait_status: interrupted` + `reason: steer`，非错误，任务继续运行）。TUI 渲染器识别 `interrupted` | `src/tools/mod.rs`（`effective_steer`/`with_steer_slot_if`）、`src/session/mod.rs`（`steer_slot`、`drain_steers` 刷新、`admit_locked` 触发）、`src/server/engine.rs`（`steer_slots` 映射）；`src/session/mod.rs` 2 项 + `src/tools/task_tools.rs` 的 `test_wait_with_a_runner_ends_on_the_steer_signal`；探针：30s 等待在 164ms 被信号结束且任务仍 `running` |
| #3846 MCP **工具调用**返回 401 → 服务器标记 `needs-auth` | 上游只在连接期翻转，调用期的 401 此前只报一句 `MCP execution error`。新增 `McpManager::mark_needs_auth`（`src/mcp/manager.rs:397`）与 `call_tool` 的 unauthorized 分叉（`:943`）：状态门（仅 `connected`/`needs-auth`）、发起方 client 绑定（`Arc::ptr_eq`）、关闭 client + 清缓存工具、错误文案改为可操作提示。并发授予窗口需要连接时刻，故新增 `ServerState.connected_at_ms`（`:96`，连接成功处 `:1174`）与 `oauth_clock`（`:379`）；OAuth 侧新增 `obtained_at_ms`（`src/mcp/oauth/service.rs:34`，由 `store_tokens` `:117` 与刷新 `:224` 打戳）、`is_concurrent_grant`（10 秒窗口，`:67`）、`peek_rejected_grant`（`:134`）、比较后清除 `clear_tokens_if_current`（`:148`）。**与上游的差异**：上游文案指向 `<server>__authenticate` 工具，本引擎没有该工具，故改写为 `/mcp-config login <name>`（与连接期翻转既有文案一致）；上游 `isUnauthorizedLikeError` 里对 `McpError` 的排除在 Rust 侧是结构性的——应用级工具失败以 `Ok` + `is_error` 返回，只有传输层错误会进 sniff | `test_tool_call_401_flips_server_to_needs_auth`、`test_concurrent_grant_survives_a_call_401`（`src/mcp/manager.rs:2674,2756`）；`test_store_tokens_stamps_obtained_at_once`、`test_concurrent_grant_window`、`test_clear_tokens_if_current`、`test_peek_rejected_grant`（`src/mcp/oauth/service.rs:401,430,466,497`）；mock 模式 `401-on-call`（`src/mcp/http.rs:176,275`） |
| 本批复核（无上游号） | MCP 传输错误从字符串改为结构化 `McpError`（`src/mcp/errors.rs:12`：`HttpStatus`/`JsonRpc`/`Timeout`/`Closed`/`Transport`，`is_unauthorized` 只认 `HttpStatus{401}`，`:55`）。此前 `needs-auth` 靠 `error.contains("401")` 判定，任何文案里带 401 的消息（含 `timed out after 401ms`）都会误翻；`should_mark_needs_auth` 现收 `unauthorized: bool`（`src/mcp/manager.rs`），`mark_needs_auth`/`mark_connect_failure` 收 `&McpError`。`Display` 逐字保留旧文案，状态面板与既有断言不受影响 | `src/mcp/errors.rs` 3 项；`test_should_mark_needs_auth_matrix`（401 判定改由分类驱动，文本含 "401" 的非 HTTP 错误明确断言为不翻） |
| 本批复核 | MCP 超时预算：`client_shared::build_http_client(stream)`（`src/mcp/client_shared.rs:34`）给普通 POST 与长生命 SSE 分别设 connect/idle 超时，且**不设总超时**（reqwest 的 `timeout` 覆盖整个响应体，会给合法长连接流判死刑）；`Budget{wait, deadline}`（`:66`）让一次调用的 POST 腿与响应腿共用**同一条**截止线 —— 此前两腿各拿一份 `wait`，最坏 2× 配置值。复核查出的两处真缺陷：SSE 的 POST 完全没有截止线（`timeout` 只包住等 SSE 回复那一段，endpoint 只接连接不回话时挂到 socket 层），以及**传输已死后的新请求**会登记进没人再清的 pending 表而白等满 30s —— 修法是把 `closed` 置位与「清 pending」放进 reader 退出的同一临界区、调用方「插入 + 复检」放进同一临界区（`src/mcp/sse.rs:47,149,246,311`），stdio 侧由 `McpClient::ensure_open`（`src/mcp/client.rs:349`）覆盖子进程自己崩掉的情形 | `test_sse_transport_post_is_bounded_by_request_timeout`、`test_sse_transport_refuses_calls_after_shutdown`、`test_sse_transport_shutdown_is_silent_and_fails_pending`（`src/mcp/sse.rs`）；`test_call_on_a_closed_client_is_refused`（`src/mcp/client.rs`）；`test_http_transport_timeout`。**三条行为测试在修复前均挂满 30s** |
| 本批复核 | MCP 工具索引只保留 `mcp__<server>__<tool>` 限定名（`src/mcp/manager.rs:587`）：此前额外按裸工具名建索引，跨服务器时 last-writer-wins，`handles()` 对裸名返回真、模型工具表却只播限定名，路由可被引到错误的服务器。同时把状态广播收敛为单一 `fan_out_status`（`:1339`），使 `emit_status` 与意外关闭监视器共享同一份「失败记 error 日志 + 监听器 panic 隔离」；`remove_server`/`mark_removed`/`reconnect` 改为先取锁摘除、**释放锁后再 kill** 客户端 | `test_same_tool_name_on_two_servers_routes_by_qualified_name`、`test_mcp_manager_discovery_and_call`（断言裸名不可路由）、`test_panicking_listener_does_not_break_emit` |
| 本批复核 | MCP 默认单次调用超时对齐 v2 并兑现文档：三个传输此前各有默认（stdio 60s、http/sse 30s），未配置 `toolTimeoutMs` 时远程服务器只有一半耐心，而用户文档写的是 60000。常量收敛为 `client_shared::DEFAULT_REQUEST_TIMEOUT`（`src/mcp/client_shared.rs:26`），stdio/http/sse 一律经 `Budget::for_request(Option<Duration>)`（`:82`）取值，不再有传输私有副本可漂移。见 §6.1 第 20 条 | `test_unset_tool_timeout_falls_back_to_the_v2_default`（`src/mcp/client_shared.rs`）；`test_timeout_resolution_precedence` 继续断言「未配置即 `None`，由传输默认接管」 |
| 本批复核 | 三处只在测试里成立的路径收口：host 侧 `transport: "mock"` 需 `KIMI_NATIVE_ALLOW_MOCK_MCP` 显式开启（`src/napi_bindings.rs:1454`），拼错的 transport 不再静默注册一个向模型喂伪造结果的服务器（跳过时记 warn）；URL 校验从「语法能解析」收紧为「必须 http(s)」（`client_shared.rs:49`），SSE `endpoint` 事件回传的跨源地址不再带走 `Authorization`（`:92`，POST 构造处剥离）；OAuth 凭据落盘改为**先建 inode 再设 0600 后写字节**（`src/mcp/oauth/store.rs:93`，沿用 `server/auth.rs:243` 的写法），原先写完才收紧，共享卷上存在世界可读窗口；失败路径清掉 staging 文件 | `test_validate_http_url_rejects_non_http_schemes_and_garbage`、`test_same_origin_matches_scheme_host_and_port`、`test_store_writes_owner_only_permissions`（`#[cfg(unix)]`）；napi 侧 `initializes native MCP servers via mcpServers param`（设变量并断言真的注册上）与 `refuses a mock transport without the test opt-in`（不设变量时必须完全不进 roster） |

验证：`cargo test --features cli --lib` → **2349 passed / 0 failed / 1 ignored**（2026-09-15）。
追加验证（2026-09-17，本轮 #3846 + #3734 移植）：`cargo check --lib` 无告警；`cargo test --lib mcp` →
**99 passed / 0 failed**（含新增 6 项）；`cargo test --lib llm::http::tests::` → **30 passed / 1 failed**，
唯一失败为前期既有的 `chat_fails_cleanly_on_unreachable_endpoint`（单独复跑同样失败，位于在途改动中的
`llm/http.rs`，与本轮无关）。
追加验证（2026-09-17，本轮 #3734 流式化 + #3688 附件留存）：`cargo test --lib` → **2608 passed / 2 failed**
（既有环境失败 1 条 + `acp::test_acp_prompt_reports_acp_stop_reason` 并发抖动，单独复跑通过）；
`cargo test --lib mcp::` 92 项、`server::` 351 项、`tools::` 647 项全绿。
追加验证（2026-09-17，本轮 #3697 阻塞等待 + steer 打断）：`cargo check --lib` 与
`cargo clippy --lib -- -D warnings` 均无告警，`cargo fmt --check` 干净；`cargo test --lib` →
**2628 passed / 0 failed / 1 ignored**（上轮 2 条失败均已消失；净增的 20 项为 #3697 新增：
`storage::task_runner` 6 项、`tools::task_tools` 8 项、`session` 2 项、`server::engine` 2 项，
另 2 项为上轮遗留计入）。顺带修掉 3 条既有 clippy 告警（`mcp/manager.rs` 两处、`mcp/oauth/service.rs`
一处，均在上轮在途改动中，CI 的 `-D warnings` 会拦下）。
迁移前用真实生产链探针复现了前提缺失（5s 等待 6ms 返回 `timed_out`），落地后同一探针测得
1009ms/1000ms、完成唤醒 169ms、30s 等待被信号在 164ms 结束且任务仍 `running`。
追加验证（2026-09-18，本轮 MCP 传输复核）：`cargo fmt --check` 干净、
`cargo clippy --all-targets --features cli -- -D warnings` 通过、`cargo test --features cli`
→ lib **2680 passed / 0 failed / 1 ignored** + 各集成套件（7 / 2 / 2 / 28）全绿；
`bun run vitest run napi-integration.test.ts` → **56 passed**，跑在 `bun run build` 重新编译的
`.node` 上（旧的 `kimi_agent.win32-x64-msvc.node` 早于整批改动，拿它测只会得出假结论）。
两条环境事实，避免后续轮次误判：**（1）本批 Rust 改动进入工作树时既没跑 `cargo fmt` 也没过
clippy**（5 个文件格式不合规、1 条 `to_string_in_format_args`），二者都是 CI 门禁项，红在合入前
不会被本地 vitest/cargo test 暴露；**（2）`mcp::manager::tests::test_unexpected_close_marks_failed_and_emits`
在 Windows 上负载敏感** —— 一次运行里它打满 30s 启动超时（同批其余 106 项 5.5s 跑完），同一份源码
两次复跑均绿，其夹具是生成的 `.bat`（`set /p` 逐行消费 stdin），抖源在 cmd.exe 侧。**未核实项**：
真实远程 MCP 服务器（外网 OAuth / 调用期 401）没有跑过，全部证据来自本地 mock 传输与真 socket
夹具；`McpError::Display` 保留的历史文案在 stdio 侧是 `MCP error: `、HTTP/SSE 侧是
`MCP Server Error: `，前缀不一致系本批之前既有且刻意保留（状态面板与测试依赖），本轮未统一。

**2026-09-22 深查轮（双边源码对读，门禁盲区）已修复**：

| 上游 | 修复 | 证据 |
|---|---|---|
| 无上游号（kosong 错误契约漂移；fork 保留 kosong，其上游修改从不进 delta 门禁，Rust 分类器引用的 `kosong/contract/errors.ts` 在两棵树上均已不存在） | 可重试状态集合从 `500..=599` 整段改为现行 v2 的显式列表 `[408, 409, 429, 500, 502, 503, 504, 529]`（kosong `errors.ts` `isRetryableGenerateError` + `human/llm/requester/retry.ts` `RETRYABLE_STATUS_CODES`，与 fork 自带的 kosong 一致）；425 作为已记录的 fork 追加保留。配额豁免补 Moonshot 文档原话 `exceeded your current token quota`（v2 正则 `/exceeded your current (?:token )?quota/` 的 token 拼写此前漏匹配，真配额耗尽被当瞬态 429 重试） | `src/llm/http.rs`；`retryable_status_set_matches_v2_explicit_list`（进/出各 10+ 码）、`quota_exhaustion_is_not_retryable`（补 token-quota 用例） |
| 无上游号（过滤 finish_reason 词汇表不全） | transport 透传 provider 停止原因，但停止原因表只认 OpenAI `content_filter`；补 v2 kosong 适配器的整个过滤族：Anthropic `refusal`、Google `safety`/`recitation`/`blocklist`/`prohibited_content`/`spii`/`image_safety`——此前安全拒答以普通完成结束回合，用户看不到过滤提示 | `src/turn_loop/run_turn.rs` `turn_stop_reason_from_finish`；`finish_reason_vocabulary_maps_to_stop_reasons` |
| 无上游号（压缩内溢出无恢复） | v2 `fullCompactionService.ts:690-710` 的压缩内恢复：摘要请求自身溢出时按 `COMPACTION_OVERFLOW_SHRINK_RATIOS`（0.7/0.5/0.35，上限 `MAX_COMPACTION_OVERFLOW_SHRINK_ATTEMPTS = 3`，共享尝试上限与 `len <= 1` 守卫）收缩重试。fork 原有 #3911 预收缩与空摘要丢最旧路径，但溢出错误不在可重试集合 → 直接失败；预估偏乐观时 v2 能救回、fork 整包压缩失败。Err 分支最前面（与 v2 同序）加该路径，估算口径同 v2 `requestTokens`，收缩走既有 `take_recent_within_budget`，无退避直接重试；工作集改 `Cow` 承载 | `src/compaction/mod.rs`；`test_summarizer_shrinks_history_after_overflow_and_retries`、`test_summarizer_gives_up_after_max_overflow_shrinks`（恰好 1+3 次请求） |
| #3875（门禁盲区：只改 apps/kimi-code，非删包）`kimi -p` 在 cron 触发时早退并取消在途回合 | **架构性不适用，无需移植**：v2 的 bug 形态是 print 后台策略（watcher）与回合循环竞态——一次性任务触发后即从日程消失，策略读到空日程判定静息；循环任务按住不放的触发时刻被防自旋守卫误判为 tick 卡死。fork 的 print run 是单顺序所有者：cron 触发由 run 自己负责（`pending_cron_followups` 在 ceiling 内睡到最早触发点、渲染 `<cron-fire>`、触发后删一次性任务），follow-up 回合**先入队**（`maybe_enqueue_print_followup`）后过 idle gate（`maybe_settle_locked`），不存在“队列空而在途回合被取消”的观测点 | `src/session/mod.rs:1016-1074`（follow-up 生产序：goal → cron → tasks，入队先于 idle gate）；`settle_print_background`（等 `running_ids` 空 + 全 run 单一 deadline） |
| #3869（审计改判：原“不适用”实为行为偏差）yolo 外模式对不可解析 bash 命令不询问 | `DangerousVerdict` 增加第三态 `Unanalyzable`（引号未配平；包装器剥离后命令名非字面量——`$CMD --force` 要到执行时才知道跑什么），`analyze_bash_command` 按“危险优先、不可解析次之、安全兜底”聚合；策略链第 3 步按 v2 #3869 分流：不可解析且**非 Yolo** → Ask（独立 reason），Yolo 落穿到 `YoloModeApprove`。修前 fork 对所有模式放行不可解析命令，v2 在非 yolo 模式询问——Ask When Needed 下上游弹审批、fork 静默执行 | `src/native/permission_engine/dangerous_command.rs`（三态 + 名字字面量检查 + 配平标志）；`src/permission/mod.rs` 策略分流；测试：`test_unanalyzable_shapes`、`test_dangerous_wins_over_unanalyzable`、`test_variable_arguments_stay_analyzable`、`test_unanalyzable_bash_command_asks_except_in_yolo`。记录的残留差异：v2 把 `bash -c "echo $HOME"` 也判不可解析（其 tree-sitter 语法所限），fork 会读内层命令判安全——变量**参数**可解析，只有变量**命令名**不可解析 |
| #3938（审计改判：原 not-applicable 的 kap-server 半件 moot，但 agent 半件是模块缺失）冷折叠步骤带 step timing/usage | 新增 `src/llm/timing.rs`：`LlmTiming`（v2 `ModelRequestTiming` 六字段，camelCase serde）。`chat_impl` 打 4 个标记（started / sent / 首个 SSE 事件 / 流结束）按 v2 `buildModelRequestTiming` 公式计算（零钳制；`serverDecodeMs`/`clientConsumeMs` 留 None——fork SSE reader 不产 decode stats）；timing 经 `LLMChatResponse.timing` → `StepResult.timing` → turn 循环每步发射 `llm.step.end`（带 turn_id/step/usage——此前该事件无生产者，projector 的 `StepTiming` 从未被填充）→ projector 折叠进步骤。传输层 sink 的同名 emission（服务宿主消息折叠）不变，两条通道消费者分离，无双处理。host-proxy 报 None | `src/llm/timing.rs` 5 项（公式/钳制/serde）；`src/server/transcript/project.rs` 的 step-end 折叠（测试断言 timing 落步）；`src/tools/agent_tool.rs` 生命周期序列现含 step end；lib 2757 通过 |
| #3847(b)（审计改判：原 not-applicable 实为模块缺失）tower 记录带调用方 token 用量 | `SubagentManager` 新增 `usage_by_instance` 按实例累计计数器，在三个回合完成路径（foreground / background `spawn_and_run` / persistent）折叠；`caller_tokens` 按 v2 `grandTotal`（四维求和，非 `total_tokens`）上报，逐出/销毁时清理防无界增长。tower 的 finding/review/send 三个写入方携带 tokens 入记录（finding `**Tokens**` 行、review/inbox frontmatter 字段），`read_inbox` 往返解析。记录的分歧：main 调用方报 `None`（v2 -1）——会话总量在宿主 SQLite、toolset 不可达；subagent 调用方完整覆盖 | `src/subagent/manager.rs`（计数器 + `caller_tokens` + 清理）；`src/tools/tower/{store,types,mod}.rs` 与 `src/tools/mod.rs` 分发；测试：`test_caller_tokens_accumulates_all_dimensions`、`file_finding_records_the_callers_tokens`、`send_records_tokens_and_read_inbox_round_trips_them`；lib 2760 通过 |
| 深查发现（无上游号，v2 `observeContextOverflow`）有效窗口学习 | `compaction` 模块新增进程内观测缓存（按模型名键）：`observe_context_overflow` / `effective_max_tokens` 逐字对应 v2 `fullCompactionService.ts:258-267,320-331`（`floor(estimated × 0.85)`、只降不升守卫、无配置窗时观测值独立成立）。调用点按 v2 原样置于**压缩请求自身溢出**的恢复分支（`summarize_with_llm_budgeted` 的 Err 分支，与 v2 catch 中位置一致）；回合级 `should_recover` 门与预收缩预算（`force_compact_messages_with_summary_report` 的 window 参数）改用 `effective_max_tokens(model, configured)`。记录的差异：v2 经 `defineState` 持久化，fork 为进程内缓存（重启后重新学习） | `src/compaction/mod.rs`（缓存 + 两函数 + 3 项单测：降/不升/无配置窗）；`src/turn_loop/run_turn.rs`（effective_window 一处构造、三处消费）；lib 2763 通过 |
| #3934（门禁盲区：code-app bundle 同步）2.0.2 web 交互改进与 bug 修复 | **已解决（2026-09-22）**：fork 的 dist-web 原先停在 2.0.2 之前的同步点（#3934 把 `CodeBlockNode-BMkbTGvt.js` 改名为 `CodeBlockNode-CGnsnQxn.js` 等，fork bundle 仍是旧文件名，`index.html` 时间戳 09-17 早于该同步）。同步前先实证 fork 的旧 bundle 与上游 2.0.0（fork 基线）的 bundle **逐字节一致**（`diff -rq` 退出 0）——无 fork 本地改动可丢，于是按“先删后拷、绝不覆盖”约定从上游 2.0.2 tag 提取替换（上游 `2e605b1` 即 code-app `44d7281c7a` 的同步，溯源链成立）：77 文件、1147 删除 / 1232 新增（旧世代确被移除而非叠加），入口 `index-DusVyqlT.js` → `index-DkwBvjsJ.js`，index.html/boot.js 引用可达性手工验证通过 | `f585c04d8d`（chore: sync web dist from code-app (#3934)，沿前三次 sync 的纯 bundle 提交惯例） |

### 6.3 文档失真清单（本轮已就地更正）

`native/glob.rs` 与 `native/bash.rs` 曾被当作 Glob/Bash 工具的实现出处（实为 55 行与 39 行的
模式匹配辅助、超时常量与 `kill_process_tree`）；`read_media.rs`、`core_tool_defs.rs` 的路径写成
`src/native/` 与 `src/` 根（实在 `src/tools/`）；`compaction/micro.rs`"354 行 + 8 个单测"实为
326 行 + 7 个；`server/remote_control.rs`"1339 行"实为 1317；`agent-core-v2`"1,018 个文件"实为
1,544；"`packages/kosong/src/providers/*` 已随 TS provider 栈一并删除"不成立（两个模型元数据文件
仍在且是活代码）；"客户端反向 RPC 10/11"实为 9 个且其中 `terminal/kill` 无调用点；"`cargo test
--lib` 2,107 项"实为 2,349；`src/native/goal/accounting.rs` 模块头仍称"goal 状态由 TS runtime 持有"，
而该 runtime 已不存在。

由此定一条本文件的规矩：**矩阵里只写能从两侧代码指出行号的声明**；一切数字（行数、测试数、
文件数、方法数）必须标注复核日期，否则一律视为陈旧。

**2026-09-19 第三轮补充（出处核对的机械化）**：对 src 内全部 48 处 `agent-core-v2/src/...`
路径引用逐条拿基准 A（upstream/main 抽取 `.tmp/v2-ref-upstream/`）与基准 B（fork 删除前的
自有 v2，`ecad4136d9^`）核对，本轮就地更正以下虚构/误标出处：

- `team/coordinator.rs` 与 `team/context.rs`：所称 `agent-core-v2/src/agent/team/` 两个文件
  在两个基准中都不存在——team 是 fork 原创，非移植；
- `tools/memory_paths.rs`：所称 `agent-core-v2/src/app/memory/` 两个文件同样两个基准皆无——
  memory 布局是 fork 原创约定；
- `tools/knowledge_tool.rs`：所称 v2 `knowledge-tool.ts` / `AgentKnowledgeService` 两基准皆无——
  knowledge 源自 kimi-native-tools（9ba414429d 并入），fork 原创；
- `compaction/micro.rs`、`native/output_truncate.rs`、`native/napi_bindings.rs`（result-builder）、
  `native/tokens.rs`：引用的是 fork 自有 v2（基准 B）真实存在、上游没有的文件——保留引用但
  标注「retired fork-only」，避免再被当作上游对齐证据。

### 6.4 宿主契约修复（2026-09-19，按 v2 裁定）

一轮针对「引擎与它真实消费者」的核对。参照基准是 **v2 本体**（`.tmp/v2-ref/`，从
`upstream/main` 抽取的 `agent-core-v2` / `kap-server` / `klient` / `acp-server`），
bundle 只用来确认「客户端确实在调这个端点」。

**结论先行：fork 的多数路由比 v2 多包了一层 envelope。** v2 的会话类端点一律
`okEnvelope(toWireSession(...))` —— **裸 session 文档**，消息在独立的
`/sessions/{id}/messages`（`{items, has_more}`）。fork 发明了 `{session, messages}`、
`{sessionId, goal}`、`{restored, session}`、`{sessionId, session, agent_config}` 这些
包装，任何按 schema 直接映射的客户端都会读空。本轮按 v2 归位：

| 端点 | v2 契约（出处） | fork 原状 | 现状态 |
|---|---|---|---|
| `GET /sessions/{id}` | 裸 session（`sessions.ts:394-441`） | `{session, messages}` | 裸 session |
| `GET /sessions/{id}/messages` | `{items, has_more}`（`rest-message.ts:14`） | `{sessionId, messages}` 且元素是裸 `LLMMessage` | `{items, has_more}`，元素经 `project_wire_message` 投影出 `content[]` 块 |
| `GET /sessions/{id}/status` | `sessionStatusResponseSchema` 十个字段（`sessionProtocol.ts:74-85`） | `permission`/`thinking_level` 写死，缺 5 个字段，多 3 个 | 字段集与 schema 一致 |
| `GET /sessions/{id}/goal` | `goalSnapshotSchema.nullable()`（`sessions.ts:798`） | `{sessionId, goal}` | 裸 snapshot 或 `null` |
| `GET/POST /sessions/{id}/profile` | 裸 session（`sessions.ts:455` / `:497-529`） | `{sessionId, session, agent_config}` | 裸 session |
| `POST /sessions` | 裸 session，**无 statusCode ⇒ 200**（`sessions.ts:181-184`） | `{sessionId,title,workspaceId}`，201 | 裸 session，200 |
| `POST /sessions/{id}:fork`、`:restore` | 裸 session（`sessions.ts:891`、`:976`） | 薄对象 / `{restored, session}` | 裸 session |
| 任务列表 / 详情 | `{items}`（可带 `status` 过滤）/ 裸 task（`tasks.ts:82-87`、`:134`） | `{tasks}`（camelCase `taskId`） | `{items}` + 协议字段名 |
| `GET /sessions` | `page_size` 默认 20 上限 100，支持 `busy`/`include_archive`/`exclude_empty`/`archived_only`/`workspace_id`；返回 `{items, has_more}`（`sessions.ts:101-136`） | 只有 `exclude_empty`/`page_size`，`has_more` 恒 false | 完整参数集与真分页 |
| OAuth 登录三端点 | `oauthFlowSnapshotSchema` snake_case + `status: pending\|authenticated\|denied\|expired\|cancelled`，`resolved_at`（`oauthProtocol.ts:5-53`） | Rust 结构体 camelCase，成功态叫 `"success"`（不在 v2 枚举里） | snake_case；`success→authenticated`，`error→denied`（v2 无 `error` 成员） |
| `POST /config` | `patchConfigRequestSchema` 十九键，`yolo===true ⇒ defaultPermissionMode='yolo'` 后丢弃该键（`config.ts:63-68`） | 只读 4 键，其余静默丢弃 | 全 section；非法 section 报错 |
| `POST /plugins` | 只收 `{source}`（`rest-plugin.ts:36-38`） | 只读 `id`/`name` | 接受 `source` |
| `GET /capabilities` | 对象数组（`capabilities.ts:49-50`） | 裸字符串数组 | 对象数组 |
| `POST /exports` | `application/zip`（`sessionExport.ts:141`） | JSON | ZIP（GET 保留 JSON 供仓内客户端） |

**一处未按 v2 归位，是有意为之**：`/workspace/fs:search` 与 `/workspace/fs:suggest`。
v2 用双冒号（`fs.ts:414,460`），bundle 用单冒号。fork 的 `::search` 分支**本来就同时
接受两种拼写**，所以 `suggest` 补上单冒号别名只是让两者一致——否则文件提及选择器每次都
白付一次 404 往返。这是「bundle 与 v2 不一致、服务端兼容两端」的唯一一处，已在代码注释
中标明 v2 的真实拼写。

同时确认并修复两处「声明了但没人消费」：`merge_all_available_skills` 现已接入引擎全部
技能扫描入口；`--agent` / `--agent-file` 原先在 `SDKРpcClientNative.createSession` 被
静默丢弃（`input.agentProfile` 零引用），现按 `docs/en/customization/agents.md:56` 的
作用域优先级在宿主侧发现，经新增 napi `agentProfile` 参数选中主代理角色，未知名以
`agent.not_found` 失败而不是静默回落默认代理。

**仍未接线，且已判定不该由本仓补**（避免下一轮重复讨论）：

- `[agent].multi_llm`：**已接线（2026-09-19）**。原先的判定是「要生效需先决定 MultiLLM 是否
  竞速原生 HTTP 传输」——该决定已做出并落地：`LlmProvider` 现在携带可选的 `NativeLlmConfig`
  （`llm/multi.rs` `LlmProvider::native`），每个 racer 用 `NativeHttpLlm` 走引擎自己的 HTTP/SSE
  通道，只有没有原生配置时才退回宿主代理；败者靠 child cancellation token 中断流（原生）或
  `cancel_llm_chat`（代理）。配置侧由 `KimiConfig::extract_multi_llm` 把每个 `[models]` 别名经
  `extract_native_llm` 解析成 racer，两条入口（`main.rs` 的 `--serve`/`--acp` 与 napi 的
  `providers`）都已接上；napi 的 `JsLlmProviderDef` 新增 `native` 字段，TS 侧新增
  `resolveMultiLlmProviders`。单条 entry 与无法解析的别名都会报错而不是静默降级。
- `extra_agent_dirs`：引擎侧确实没有任何 agent 定义发现逻辑（`SubagentManager` 只接受
  宿主 push），宿主侧发现已按文档实现并送达引擎，因此该配置键的有效路径已经存在。
- `apps/vis` 的 `imported_from_kimi_cli` 过滤：`packages/migration-legacy` 随迁移功能一并
  删除后已无写入方，但保留读取是**向后兼容**——移除会让历史上已迁移的会话重新出现。

### 6.5 合并上游 2.0.0（2026-09-17）

本地 0.42.0 落后上游 81 个提交；合并对象是 tag `@moonshot-ai/kimi-code@2.0.0`
（= `upstream/main` 后退 4 个提交）。

**规模与处理方式。** 380 个未合并文件：**369 个是 fork 已退役包**（`agent-core-v2` 299、
`kap-server` 49、`klient` 15、`acp-server` 4、`migration-legacy` 1、`pnpm-lock` 1），按政策保留删除；
余下 56 个内容冲突逐个手工合并。

**必须记住的坑（本轮实测）。** 上游仍保留这些包，而我侧删了目录，于是**上游在 merge-base 之后
新增的文件会被 git 当作「单侧新增」静默合入**：本轮索引里一次多出 126 个退役包文件
（`agent-core-v2` 61、`kap-server` 64、`klient` 1），它们**不是**冲突态，`git status` 不会提醒。
合并后必须扫 `git ls-files --cached` 里退役包路径的文件数，并逐个确认。另有两处同类残留：
磁盘上空目录（`rm -rf` 清掉）与 `git rm --cached` 后留在工作区的未跟踪文件。

**落在这一轮的取舍（三个非机械判断）。**

1. **`kimi-tui.ts` 的会话选择器**：fork 已把选择器整体迁进 `controllers/dialog-host.ts`，
   `KimiTUI` 只做委托；上游的 2.0.0 侧仍是内联实现（155 行）并新增了**删除会话**功能
   （`onDeleteRequest` / `Ctrl+X`）。取 ours 会丢掉删除功能，取 theirs 会让选择器
   在 `kimi-tui.ts` 与 `dialog-host.ts` 各存一份。做法：保留委托，把删除功能**移植进**
   `dialog-host.ts` —— 新增 `allowDelete` 选项（启动期的 picker 不提供删除，那时还没有会话可删）、
   `invalidateSessionPickerScopeRequests()` 与 `remountSessionPickerIfOpen()` 两个原语，
   `DialogHost` 接口加 `deleteSessionFromPicker`。
2. **`subagent.cancelled`**：上游 2.0.0 引入了它，但该事件**只由已退役的 `agent-core-v2`
   发出**；本引擎的 `EngineEvent` 枚举只有 `subagent.spawned` / `completed` / `failed` 三个
   变体（`events/types.rs:135-144`），`started` / `suspended` / `message` / `cancelled` 是经
   `EngineEvent::Custom` JSON 携带的同词表事件（`agent_tool.rs`、`subagent/persistent.rs`）。
   （2026-09-19 复核记录：本条写作时的「枚举只发六种」措辞不准——见下文「`subagent.cancelled`
   已补上」，该缺口后来已真实补齐。）故 `notify.ts`、`session-event-handler.ts`、
   `subagent-event-handler.ts` 里的 `cancelled` 分支全部**不取**（取了会 TS2678/TS2344 编译失败）。
   同时确认：`subagent.message` 是本引擎会发的事件，若按上游把类型守卫从
   `startsWith('subagent.')` 改成显式六项清单，它会被静默丢掉 —— 故保留 `startsWith`。
3. **`flake.nix` / `_native-build.yml`**：上游这份把 `bunDeps` 换成 `fetchPnpmDeps`
   （fork 的 flake 里没有 `pnpm` 绑定，取了会 Nix 求值失败）、把构建步骤换成
   `pnpm --filter … build:native:sea`（该脚本在本 fork 不存在）。均取 ours，只把上游的
   Azure 签名 `env:` 块嫁接进 Bun 构建步骤 —— fork 自己的 `04-sign.mjs` 认得
   `KIMI_AZURE_TRUSTED_SIGNING`。

**新增的上游行为 delta。**

- **#3869「yolo 模式放行不可分析的 bash 命令」记为 `not-applicable`（含实测证据）**：v2 的
  DangerousCommandAsk 有三种结果（dangerous / unanalyzable / 无 verdict），因为它把命令交给
  tree-sitter 解析器、解析可以失败；本引擎的 `analyze_bash_command` 是手写 tokenizer，
  签名 `fn(&str) -> DangerousVerdict` 只有 Dangerous/Safe 两种，**结构上无法表达解析失败**。
  实测（临时单测跑完即删）十个输入：`echo 'unclosed`、`if [ -f x ]; then`、`for i in 1 2 3; do`、
  `$((`、`;;;`、`)))`、`\`、空串、纯空格全部 Safe，只有 `sudo reboot` 是
  `Dangerous("reboot")`。故这些命令在 yolo 下已由 `YoloModeApprove`（`permission/mod.rs:440`）
  放行、在 ask 下走常规审批 —— 与 #3869 的目标一致，只是路径不同。
- **非交互（`kimi -p`）下跳过 DangerousCommandAsk —— 已对齐（2026-09-19 本轮）**：上游
  `permissionPolicyService.ts` 在 bootstrap `nonInteractive` 时把该 ask 策略整体从链中移除
  （无人可应答）；本引擎的策略链此前无条件求值。现 `PolicySnapshot` 增 `non_interactive`
  （`wire-schema.ts` 同名可选字段，print 会话经 `CreateSessionOptions.nonInteractive` →
  session meta → policy snapshot 传入），为真时跳过 #3，其余策略照常判定
  （`permission/mod.rs`，测试 `test_non_interactive_session_skips_dangerous_command_ask`）。
- **#3843「skill scopes（`tui` / `web` 白名单）+ custom-theme 标记为 tui-only」尚未落地**：
  上游把该字段穿过 `SkillSummary`、klient RPC 与 kap-server REST；本引擎的技能目录**不产出
  `scopes`**（全仓 `rg '"scopes"'` 无命中）。已先在 `packages/node-sdk/src/types.ts` 的
  `SkillSummary` 上补可选字段（引擎未发，取值为 `undefined` 时语义即「所有界面可见」，
  与上游默认一致），TUI 侧的过滤逻辑已经就位；真正要做的是让引擎的技能目录产出该字段。

17. ~~**#3843 skill scopes 未落地（引擎侧）**~~ **已落地（2026-09-19 复核更正）**。复核发现本条
    描述已过时——引擎侧当时随 tower 任务落地（`21403bf956` 引入字段 + 快照提交入 main）：
    `skills/mod.rs` 的 `SkillDescriptor.scopes: Option<Vec<String>>`（serde camelCase 上 wire，
    `None` 即处处可见）、`parse_skill_metadata_with_scopes` 解析 frontmatter 的 `scopes:`
    （括号/裸列表/单 token，未知 token 丢弃）、内置 `custom-theme` 标记 `["tui"]`。三条 REST
    出口（`GET /api/v1/skills`、workspace skills、session skills）均流经该描述符，scopes 随
    serde 自动上 wire；SDK `SkillSummary.scopes?` 与 TUI `isVisibleOnTui()` 过滤已就位。
    测试：`test_parse_scopes_frontmatter`（4 形态）、`test_custom_theme_builtin_is_tui_scoped`。
    复核教训：此前以 `rg '"scopes"'` 判「引擎不产出」——Rust 结构体字段名不带引号，该 grep
    模式天然匹配不到，判定前应直接读类型定义。

**`subagent.cancelled` 已补上（合并中发现的真实缺口）。** 上游 v2 引擎在用户打断子代理时发
**独立**的 `subagent.cancelled` 事件（`agent-core-v2/src/session/subagent/mirrorAgentRun.ts:77`），
本引擎此前把它并进 `subagent.failed` + 一段文案（`USER_INTERRUPTED_SUBAGENT_MESSAGE`），
由客户端 `isUserCancelledSubagentError()` 反解。合并时上游带来的一批测试断言的是那个独立事件，
据此把缺口补齐：

- **引擎侧**：`src/tools/agent_tool.rs` 新增 `emit_cancelled()`，并在两条打断路径上发出——
  前台 `ForegroundTurnOutcome::ParentCancelled`（`agent_tool.rs:744` 附近）与前台 turn 的
  `LoopTurnStopReason::Aborted` + `parent_cancel.triggered()` 分支；后台子代理的
  `ParentCancelled` 分支也从 `subagent.failed` 改为 `subagent.cancelled`。
  工具结果文案不变（仍是 `USER_INTERRUPTED_SUBAGENT_MESSAGE`），因为那是模型可见的产出。
- **协议侧**：`packages/protocol/src/events.ts` 增 `SubagentCancelledEvent` 接口、zod schema，
  并加入类型 union 与 `agentEventSchema`。若无这一步，客户端 switch 里的
  `case 'subagent.cancelled'` 会 TS2678（不可比较）——即"协议不认识该事件"。
- **客户端侧**：恢复上游的 `handleSubagentCancelled` / `handleForegroundSubagentCancelled`
  （`subagent-event-handler.ts`），`notify.ts` 与 `session-event-handler.ts` 的 switch 加回该分支。
  `isSubagentLifecycleEvent` 保持 `startsWith('subagent.')` —— 显式白名单会漏掉引擎同样会发的
  `subagent.message`。
- 两条路径**并存**：swarm 的结构化结果仍可能以 `failed` + 文案表达打断，
  `isUserCancelledSubagentError` 保留兜底。

18. **#3762 provider 凭据 `api_key_env`（TS 侧 + 引擎侧）**：上游 `c5ad17f06a`
    重排了 provider 凭据解析（oauth 包新增 `provider-credential.ts`，80 个文件），
    支持 `api_key_env` 让凭据从环境变量读取。本 fork 的凭据路径同样经
    `packages/oauth`，合并会保持与上游同步；但该提交与退役引擎的凭据读取纠缠，
    需要单独一轮对照 fork 的凭据流再移植。**验收**：`[providers.*]` 支持
    `api_key_env`，凭据从指定环境变量读取且优先级与上游一致。
    **现状（2026-09-19 复核）**：**已落地并转绿**。引擎侧与 TS 侧经 `feat/api-key-env-rust-ts`
    合入 main（`2c171199d6` 全链路、`5f2643bef9` resolver 精确对齐 Rust 过滤、`53e9c81610`
    wire-schema 声明、`332857c7ba` 测试钉住）。`bun scripts/scan-parity.mjs` 在 main 上实测通过
    （`nllm 18/16 fields`，无 `api_key_env` 报错）——本条目早先「门禁在 main 上不干净」的记录
    是合入前的状态，不是现状。

19. **0.40–2.0.0 核查裁定的 fork/upstream 行为差异（2026-09-17，本轮核查新增）**：对
    `apps/kimi-code/CHANGELOG.md` 0.40.0–2.0.0 七个版本逐条核查后，三条声明与上游实现路径
    绑定过深，裁定为**有意不移植的差异**，记录如下以免后续核查再报：
    - **`[database]` 配置段 + `KIMI_CODE_PERSISTENCE_MINIDB_READMODEL` /
      `KIMI_CODE_SEARCH_WORKER`（上游 0.42.0）**：minidb 会话索引读模型与搜索 worker 是
      退役 TS 引擎的架构（agent-core-v2 的 IQueryStore / MiniDB 派生读模型）；fork 引擎的
      等价能力由 Rust 侧 SQLite 会话存储 + 进程内搜索承担。为不存在的代码路径加配置开关
      只会造死配置。上游若把该能力重做到引擎侧，再对照移植。
    - **用户级 skill 目录 fs watcher（上游 0.42.0 #3608）**：上游用文件系统监听实现
      `~/.kimi-code/skills`、`~/.agents/skills` 的免重启热刷新；fork 通过「每次目录请求
      全量重扫 + TUI 主动刷新」达成同一可观测结果（`sdk-rpc-client-native.ts` 的
      listWorkspaceSkills 每次调用重扫）。真 watcher 的跨平台生命周期成本高于收益。
    - **tower worker 从基检出未提交变更启动（上游 0.40.0 #3346）**：上游让 worker
      worktree 继承基检出的 uncommitted changes；fork 的 worktree 只从 base 分支已提交
      状态创建（`tower/git.rs` 的 `worktree_add`），未提交内容留在主检出、由
      merge 前的 dirty-checkout 门禁（`tower/store.rs` merge gate）保护。mission 隔离
      语义下这是更保守的行为；如需对齐，须把「主检出脏状态快照」接到 worktree 创建，
      并同步 TowerMerge 的拒绝条件。

20. ~~**MCP 默认请求超时三个传输不一致（2026-09-18 复核新增，待定方向）**~~ **已解决
    （2026-09-18 本轮，方向 = 对齐 v2 的 60s）**：未配置
    `toolTimeoutMs` 时，stdio 走 `src/mcp/client.rs` 的 60s，http/sse 各自藏着 30s ——
    三处注释文字相同、值不同。**v2 是对照**：`mcpCore/connection-manager.ts:390` 把
    `config.toolTimeoutMs ?? defaults.toolTimeoutMs`（可为 `undefined`）交给每个传输，
    `mcpCore/client-shared.ts:58` 原样传出，最终落到 MCP SDK 的
    `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`，三种传输一律 60s。即 **stdio 的 60s 才是对齐侧，
    多数那一侧（30s）是漂移侧** —— 别按多数统一。第二重证据：面向用户的文档
    （`docs/en/configuration/config-files.md` 与其 zh 镜像的 `[mcp] tool_timeout_ms` 行）
    本来就写 `60000`，所以 30s 同时是偏离 v2 与**代码没兑现文档**。落地方式不是改数字而是
    拆掉可漂移的形态：常量收敛到 `client_shared::DEFAULT_REQUEST_TIMEOUT`，三个传输一律经
    `Budget::for_request(self.request_timeout)` 取值，回归由
    `test_unset_tool_timeout_falls_back_to_the_v2_default` 钉住（改这个数字会显式弄红测试）。
    启动超时不在此列：v2 `DEFAULT_STARTUP_TIMEOUT_MS = 30_000`（`connection-manager.ts:64`）
    与引擎 `DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000` 一致，未动。

### 6.6 门禁范围外批次复核（2026-09-21，上游 `88a7d932f1` 之后的 17 提交）

**背景**：`scripts/check-upstream-v2-delta.mjs` 的检查区间是 `mergeBase..upstream/main`，
而本地 `refs/remotes/upstream/main` 一度停在 `88a7d932f1`（09-18）且 `git fetch upstream`
被墙（github.com:443 不通；`gh api` 走的 api.github.com 正常）。09-18 之后的提交因此
**落在门禁视野之外**——正是 §6.0「ref 过期让门禁静默缩小检查范围」那条教训的再现。
本轮先用 `gh api repos/MoonshotAI/kimi-code/compare/88a7d932f1...main` 逐条取回 17 个
提交并裁定；**2026-09-21 网络恢复后 `git fetch upstream` 成功，ref 推进到 `0523bafb3`，
其中 11 个触及被删除包的提交已连同本表裁定写入门禁 allowlist（每条 `roadmap: §6.6`），
门禁恢复全量视野（28 条全分类）**。

| 上游提交 | 内容 | 裁定 |
| --- | --- | --- |
| `2502d2157` #3920 | 整体 revert v3 扁平实体协议 | **已跟随**（`86f30ecc2c`，§8.11） |
| `7d3f88faa` #3921 | managed `/me` 增 `goods_version` | **已移植**（`703cfa23c7`，oauth 包 + 双语文档） |
| `6a52dd781` #3962 + `6ffdf0d57` #3929 | `auto_session_title` 配置项 + 系统提示词去掉 project-root 断言 | **已移植**（`acd5c8f16f`） |
| `02d829e13` #3915 | vscode 问题对话框 IME 组词时 Enter 误提交 | **已移植**（`9681ec28c9`，`QuestionDialog.tsx` 加 `isComposing` 守卫；composer 早有同款守卫） |
| `0523bafb3` #3963 | 遥测报启用插件集 + `plugin_toggle` 事件 | **已移植**（`9681ec28c9`：REST 路由与 TUI 开关点双发射点；`TelemetryContext`/`JsTelemetryContext`/napi 契约补 `enabled_plugins`。后续收尾：`e97f76186b` 打通 TUI turn 遥测全链路、`cb3fbef5b6`+`a89bf66ffb` 闭合 origin 数据链——SDK 路径的 `enabled_plugins` 按「无插件快照」语义刻意缺席，理由见下方收尾段） |
| `f17a22ebf` #3931 | 文件监听默认关 | **不适用**（记录于 `acd5c8f16f`）：fork 没有文件监听特性，无默认值可翻 |
| `b428bfd00` #3938 | 冷折叠 step 带 timing/usage | **不适用**：kap 侧 hunk 只是 v3 实体字段改名（v3 已删）；agent 侧是 context-memory 的 sealing meta，而 fork 引擎**没有 LLM timing 插桩**（全仓仅 `server/transcript/model.rs` 的 `StepTiming` 定义，projector 建 step 时 `timing: None` 永不填充；`LlmStepEnd` 只带 turn_id/step/usage）。usage 在 fork 是 turn/step 粒度（`session/sqlite_store.rs:245` TurnRecord.usage + `server/transcript/project.rs:275-282` 的 step.usage），不在 assistant 消息上 |
| `2cedfaf12` #3901 | interaction 事件过 agent 过滤器 | **不适用**：fork 的 WS 扇出是**会话级**（`server/ws.rs:444-447` 只按 session 集合过滤），没有 agent 过滤器可绕过；载荷上的 `agent_id` 也无消费方（dist-web 的 `_5e`/`T5e` mapper 不读它），且 fork 的 interaction 注册表是会话作用域、无 agent 归属可填 |
| `9df7a9ccf` #3922 | turn id 防重放回退 + 冷转录按活跃分支折叠 | **不适用**（两半）：(a) fork 的 turn 号每轮从 SQLite `MAX(turn_number)+1` 重算（`session/sqlite_store.rs:1085`），无内存计数器可被重放种子记录拨回；(b) fork 没有 wire journal 也没有分支——undo 是行删除（`sqlite_store.rs:911`）、fork 是复制历史到新会话（`fork_session`），冷转录直接读 SQLite；且该修复扩展的 v3 实体协议已随 `86f30ecc2c` 删除 |
| `97212596f` #3933 | 未消费 steer 种子下一回合时不记 `turn.steer` | **不适用**：fork 没有 `TurnSteer` 记录、没有种子回合路径（`consumeDrainedNudges` 无对应物，`drain_steers` 只把消息并进在跑回合的 `messages`）。复核中发现的真实分歧（server 路径取消时丢弃未 drain 的 steer）已另案修掉：§6.1 第 9 项，`release_turn_steer_state` 让非空队列存活过回合边界，对齐 session 路径与 v2 语义 |
| `65ae3e368` #3847 | 拒绝非 ASCII mission 标题 + 记录 token 用量 | **不适用**（三部分）：(a) fork 的 `unique_slug` 去重（`tools/tower/store.rs:412-424`、`paths.rs:96-114`）已修掉上游 rejection 针对的分支碰撞缺陷，且对中文用户更友好；(b) `tokens` 需要调用方累计用量，而 fork 的 tower 工具路径没有用量访问器（子代理实例不累计、主会话用量只在 SQLite 且 toolset 不持有），完整移植等于新建遥测基建；(c) fork 的 tower spawn 不注册带描述的后台任务（worker 经 `tokio::spawn` + `subagent.completed/failed` 事件露面），无任务描述可改 |
| `6a214b85e` #3957 | wireCache 大文件栈溢出 | **不适用**：kap-server 已退役；fork 仅存的 wire.jsonl 读取器（`apps/vis/server/src/lib/wire-reader.ts:124`）是逐条 `push`，无 spread 模式 |
| `7568f3118` #3932 | 删除 tdd skill | **不适用**：skill 清单是 fork 自有约定，根 AGENTS.md 明确要求按 `tdd` skill 工作 |
| `2e605b10b` #3934 / `9d07f634b` #3913 / `99eaa993b` #3936 | 同步 web dist / CI release / changelog 文档 | **不适用**：机械同步与 CI/文档类提交；fork 的 dist-web 按自有节奏从 code-app 同步（AGENTS.md：禁止从 `apps/kimi-web` 重建），发布流与 changelog 流程独立 |

**§6.0 快照更正**：该节「当前快照 ported=4 | tracked=8」为过期数字；门禁实时输出
（2026-09-21）为 `ported=12 | not-applicable=5`（17 条，tracked=0）。

**#3963 后续收尾（2026-09-21 晚）**：`9681ec28c9` 只落了接缝与两个开关点，TUI 路径此前
**根本不发射** turn 遥测——session pump 直接调 `run_turn_continued`，`params.telemetry`
没有任何树内宿主填充。本轮补齐全链路：(a) `run_turn.rs` 提取出
`run_turn_with_lifecycle_telemetry`（turn_started/turn_ended/turn_interrupted；goal 域事件
仍留在 `run_turn_with_telemetry`——pump 自己驱动 goal 后续回合）；(b) `SessionConfig`/
`SessionContext` 新增 `telemetry` 字段，pump 有上下文时经遥测接缝发射；(c) napi
`createEngineSession` 把 `params.telemetry` 传进 SessionConfig；(d) SDK `buildHandle` 填充
上下文（mode=planMode?'plan':'agent'、providerType 经新增的 `providerTypeForAlias`、
protocol、thinkingEffort）并把 `telemetry` 回调转发到宿主遥传客户端。验证：
`native-harness.test.ts` 新增用例走真实引擎 + mock OpenAI 服务，断言 turn_started/ended
的载荷形状。**`enabled_plugins` 在 SDK 路径刻意缺席**：唯一来源是引擎插件注册表，读取它会在
每次建会话时打开该 SQLite store（`ensurePluginStore`）——既是行为变更也锁住数据目录
（实测令 8 个 config 测试 EBUSY），故按 v2「无插件快照」语义留空；开关时的启用集仍由
`plugin_toggle` 事件按需携带。

---

## 7. v1 / v3 协议面自创实现审计（2026-09-20，按铁律）

> **v3 部分已作废**：上游 2.0.2 整体 revert 了 v3（`2502d2157`），fork 跟随撤销
> （`86f30ecc2c`，见 §8.11）。本节 v3 结论是撤销前的审计记录，仅存历史价值。

复核方式：把 Rust 侧声明的协议词表与参考实现逐项比对，**不读本仓文档、只看两侧代码**。
参考源：`upstream/main`（`git grep`）与本地抽取 `.tmp/v2-ref` / `.tmp/v2-ref-upstream`。
消费者证据：已提交的 `apps/kimi-code/dist-web` bundle（与 upstream 逐字节相同）。

### 7.1 v3 实体协议：**零偏差**

- 26 个 `ServerMessage` 变体 vs upstream `serverMessageSchema` 的 26 个 discriminated-union 成员
  （`packages/kap-server/src/protocol/messages/union.ts`）：**名称一一对应，无多余、无缺失**。
- 24 个实体类型的字段集逐项比对（脚本化，解开 `...timelineMessageBase` / `...sessionMessageBase`
  / `...globalMessageBase` 展开）：**0 处不匹配**。
- 5 个状态词表逐项一致：`TurnStatus`(running/completed)、`StepStatus`(running/completed/
  interrupted/failed)、`TaskStatus`(running/completed/failed/timed_out/killed/lost)、
  `ToolCallStatus`(running/done/error)、`InteractionStatus`(pending/approved/rejected/
  cancelled/answered/dismissed)。

### 7.2 v1 transcript op 词表：**零偏差**

14 个 op（`packages/kimi-agent/src/server/transcript/ops.rs`）vs
`packages/transcript/src/contract/schema.ts` 的 14 个 `z.literal`：**完全一致**。

### 7.3 v1 WS 控制帧：**4 处自创 —— 已全部对齐（2026-09-20，用户裁决）**

Rust `parse_inbound`（`src/server/ws_protocol.rs`）曾接受 16 种客户端帧；
upstream `ws-control.ts` 的 `clientControlOperations` 是 12 种。多出的 4 种：

| 帧 | 参考实现 | 消费者 | 处置 |
|---|---|---|---|
| `watch_fs_add` | **曾是 v1 协议的一部分，被上游 #3502 主动删除** | 无（dist-web 0 命中，无 TS 客户端发送） | **已删除整套** |
| `watch_fs_remove` | 同上 | 同上 | **已删除整套** |
| `cancel` | 无此 WS 帧字面量（`cancel` 只出现在 compaction 状态机、goal_control 枚举、minidb worker） | 无 | **已删除别名** |
| `prompt` | 无此 WS 帧（提示词走 REST `POST /sessions/{id}/prompts`） | 无 | **已删除别名** |

**关键更正（推翻本文件 §1 与 §5 的旧记录）**：`watch_fs_*` / `event.fs.changed`
**不是**「上游没有、fork 自创」，而是**上游曾有、后被删除**。
`3f967e1410`（#3502 "unify fs watching into a single xstate watch service"）把这套 WS 面
从 v1 协议移除——同提交删掉了 `docs/en/reference/server-api.md` 里那一行，改为 v2 引擎内部的
`human/utils/watch.ts`（xstate 服务，**无 wire 面**，仅 `createWatchService` 自用）。
fork 的 `fs_watch.rs`（`9b45052868`，2026-09-14）是在上游删除之后**重建的旧接口**。
本文件 §1 该行与 §5 第 2 条此前记为「已接线 ✅」，方向记反了，已就地更正。

`ws_protocol.rs` 的注释曾把出处写作 `ws-control.ts:198-215`，**该行区间实为
`terminalAttach`/`terminalDetach`**，属错误引用，随本次删除一并修正。

`cancel`/`prompt` 曾与 `abort` 共用一条 arm；上游 `abortPayloadSchema` 要求
`{ session_id, prompt_id }`，Rust 曾只取 `session_id`，**丢弃 `prompt_id`**。
现 `Inbound::Abort` 携带两者，ack 按上游 `abortAckPayloadSchema` 回 `{ aborted }`
（`at_seq` 为可选且本引擎无序列水位，故省略而非回 0）。

**本次落地（用户批准「按上游删除整套 + 删两个别名并补齐 abort」）**：

- 删除 `src/server/fs_watch.rs`（251 行 + 3 测试）与 `event.fs.changed`；
- `ws_protocol.rs`：删 `WatchFsAdd`/`WatchFsRemove` 变体与解析、删 `prompt` 帧、
  删 `cancel` 别名，新增 `Inbound::Abort { id, session_id, prompt_id }`；
- `ws.rs`：删 `WatchRegistry` 及其 drop guard、删 `Inbound::Prompt` 整段（含 tokio::spawn
  的 turn 驱动路径）、删两个 WatchFs 分支；顺带删除只为 prompt 异步 ack 存在的
  `async_frame_tx/rx` 通道与 `handle_inbound` 的对应参数；
- `mod.rs` / `http.rs` / `main.rs`：删 `fs_watch` 字段、访问器、构造与 750ms 轮询任务；
- `packages/protocol/src/ws-control.ts`：删 `watchFsConfigSchema`、`subscribe.watch_fs` 字段、
  4 个 watchFs schema、2 条 operation 注册；测试同步删 5 个用例。

**验证**：`cargo test --features cli` → **2729 passed / 0 failed**（lib）+ 各集成套件
（7 / 2 / 2 / 28）全绿；`cargo clippy --all-targets --features cli -- -D warnings` 通过；
`cargo fmt --check` 干净；`bun --bun run vitest run packages/protocol packages/transcript`
→ **711 passed**；`bun scripts/scan-parity.mjs` 通过（WS ctl 由 12 → **10**，与删后声明一致）。
`test_ws_prompt_and_cancel_frames` 重写为 `test_ws_abort_frame_and_retired_prompt_cancel_names`，
断言「两个退役帧名不产生 ack、abort 是线上第一个 ack 且 payload 为 `{aborted:false}`」。

### 7.4 同时确认「上游也未实现」的帧（非 fork 缺陷，保留）

`terminal_attach`/`terminal_detach`/`terminal_input`/`terminal_resize`/`terminal_close`
与 `abort` 在 upstream `ws-control.ts` 里有 schema，但 **kap-server 全树无消费者**
（`wsConnectionV1.ts` 只 case 6 种：`client_hello`/`pong`/`subscribe`/`subscribe_v2`/
`unsubscribe`/`unsubscribe_v2`）。fork 实现了它们，客户端也在发（bundle 的
`this.send` 共 12 种帧类型）。**这是 fork 补齐上游留白，不是自创**，本轮保留。

### 7.5 ~~本轮发现的**新**缺口：`subscribe_v2` / `unsubscribe_v2` 在 TS 侧未声明~~ **已闭合（2026-09-21，`adc794635c`）**

对齐后 `scan-parity` 报 `WS ctl 10 client ops`，而 upstream `clientControlOperations`
是 **12** 条。差的正是 `subscribe_v2` / `unsubscribe_v2`：Rust `parse_inbound` 两种都解析、
shipped bundle 两种都发送（`this.send` 列表含 `subscribe_v2`/`unsubscribe_v2`），
但 `packages/protocol/src/ws-control.ts` 从未声明它们——**这是先于本轮就存在的缺口**
（HEAD 的 12 = 10 真实 + 本轮删掉的 2 个 watchFs，与 v2 op 无关）。

**未修的原因**：补齐需要 `transcriptGradeSpecSchema` / `transcriptSeqSchema`，
它们在 `packages/transcript` 已存在（`src/contract/schema.ts:449,451`），但
`packages/protocol` 当前**不依赖** `@moonshot-ai/transcript`（其 deps 只有 `ulid` + `zod`），
引入会新增一条 workspace 包依赖边。这是结构决策，不由本轮擅自决定。
可选：(a) 给 protocol 加 transcript 依赖并 import（无环，已确认 transcript 不依赖 protocol）；
(b) 在 protocol 内复刻这两个 schema（避免新依赖，但有重复定义风险）；(c) 维持现状。


**闭合记录（2026-09-22 复核）**：采用当年的选项 (a)——`packages/protocol` 引入
`@moonshot-ai/transcript` workspace 依赖（无环，transcript 不依赖 protocol），
`ws-control.ts` import `transcriptGradeSpecSchema` / `transcriptSeqSchema` 并声明两个 op；
`scan-parity` 的 `WS ctl` 由此回到 12（与 upstream `clientControlOperations` 一致），
`ws-control.test.ts` 有 §3.3b 专测。下方「未修的原因」与三个选项为历史决策记录，不再有效。

### 7.6 端到端实跑暴露的**新**缺口：UI 的「中断」按钮 404（**已解决 2026-09-20 订正轮**）

真机验证（真服务器 + 真 Web UI + mock LLM）时，点击 UI 的「中断」按钮，
浏览器控制台出现：

```
[ERROR] 404 POST /api/v1/sessions/<sid>/prompts/msg-u2:abort
```

**根因**（非本轮引入）：该路由**存在**（`server/mod.rs` 的 `.../prompts/{id}:abort` 分支），
但它只对 `prompt_queue` 里登记过的 prompt 生效——`prompt_queue.cancel()` 返回 `None` 时回
`PROMPT_NOT_FOUND`(404)。UI 传的是 `msg-u2`（消息 id），而该 prompt 未经
`POST .../prompts` 入队（走的是另一条驱动路径），于是查不到 → 404。

**证据**：`git show HEAD:packages/kimi-agent/src/server/mod.rs` 里同一 404 分支已存在
（`contains(...)` 检查），故与本轮 WS 对齐无关。本轮只动了 WS 控制帧，未触 `prompt_queue`。

**与 WS `abort` 帧的关系**：两者是同一动作的两条通道。WS 帧（本轮已对齐为
`{session_id, prompt_id}` → ack `{aborted}`）实测可用（见 7.3 验证）；
REST 这条是 UI 实际点击的路径，**仍未闭环**。修它需要决定「消息 id 与 prompt id 的对应」
或让驱动路径也登记队列，属行为设计，未擅自处理。

**2026-09-20 订正轮已闭环**。id 对应关系在代码里本来就是确定的，无需行为设计：
`message_events.rs:127` 的 `announce_prompt` 用 `msg-u{turn_number}` 发
`event.message.created`，而 `run_prompt_loop`（`prompt_queue.rs:279`）跑该 turn 前刚
`next_turn_number()` 算出同一个数。落地：

- `Entry` 增 `turn_number: Option<u32>`，`stamp_active_turn`（`prompt_queue.rs`）由
  `run_prompt_loop` 每回合盖章；
- `cancel_by_user_message_id`（同文件）解析两种客户端持有的 scheme：`msg-u{turn}`
  （live 事件 id，经盖章的 turn 归到 active prompt）与 `msg-{prompt_id}`（prompt item
  自己的 `user_message_id`，`mod.rs:733`）；前者不命中时回落到后者，客户端自选 prompt id
  恰以 `u` 开头时仍可解析；
- `cancel` 重构出 `cancel_locked`，两条路径同一把锁内完成，无 TOCTOU；
- abort 路由（`mod.rs:6583` 起）先 `cancel` 后 `cancel_by_user_message_id`，
  `prompt.aborted` 事件带**解析后的** prompt id。

验证：`prompt_queue` 11 项（含两条新测试：live id 归到 active prompt、item 自有 scheme
解析 active+queued、未知 id 仍 404）+ 路由层
`abort_resolves_the_live_user_message_id_at_the_route`（真实 `handle_request`，
 admitted prompt + stamp turn 2 → `msg-u2:abort` 回 200 且 active 已取消）。

### 7.7 订正轮（2026-09-20）补强的投影面与仍开放的缺口

**v3 user/turn 实体的 `attachment_ids` 已补全**（§7.1 只证明了字段集零偏差，投影填充是
另一轴）。`projection.rs` 的 `attachment_ids(blocks)` 从存储的 blocks 推导：
`MediaRef.file_id` 与 `*Url.id`（`Some` 时）是附件，内联 base64 与无 id 的 URL 不是
（上游 `attachment_ids` 指名文件，不指名字节）。steered 与 turn-opener 两条构造点 +
turn 实体（取开场 user消息的附件）均已接入；live 侧仍为 `None`——`EngineEvent::TurnStarted`
只带 prompt 文本，不带 blocks（改它要动引擎事件形状，留待决策）。
测试：`user_and_turn_entities_name_the_prompts_attachments`（projection 单测）。
**2026-09-22 复核：整项随 v3 退役而 moot**——`projection.rs` 已随 `86f30ecc2c` 删除，
「live 侧 None」原是 v3 turn 实体 `attachmentIds` 的填充缺口；v1 live 路径
（`project.rs` 的 `event.message.created` → `attachment_from_block` → `upsert_attachment`）
本就产出 attachment，无同类缺口。

**`skill_activations` 的数据链（2026-09-22 闭合宿主半件）**：全仓 grep 曾只有 4 处 `None` + 1 处
测试夹具，`TranscriptUserOrigin.skill_activations`（`transcript/model.rs:311`）有定义无生产者。
现已闭合**宿主 → 引擎 → turn 事件**半件：(a) napi `session_enqueue_turn` 把 prompt 对象上的
`origin`（v2 `PromptOrigin` JSON）拆下来挂到 `TurnRequest`（`LLMMessage` 不建模 origin 变体，
serde 原忽略未知字段）；(b) SDK `turnEvent` 的 `turn.started` 转发引擎回显的 origin，不再硬编码
`{kind:"user"}`；(c) SDK `activateSkill` 按 bundle 的确切形状
（`metadata.origin`，zod `skill_activation` 变体）铸造 `SkillActivationOrigin` 并经
`clientMetadata` 随 prompt/steer 两路透传。消费端本就存在：TUI replay 读
`message.origin.skillActivations`（`session-replay.ts:220`）与 `origin.activationId`
（`message-replay.ts:259`）。验证：napi 集成测试 `echoes a prompt origin on the turn events`
（origin 原样回环 + 无 origin 时默认 user）。
**持久半件（2026-09-22 闭环）**：`LLMMessage` 增加 `origin: Option<Value>`（derive 去掉
`Eq`——`Value` 不满足；全仓无 `LLMMessage: Eq` 依赖，`MicroCompactionOutcome` 的 `Eq`
连带移除），pump 把回合 origin 挂到开场 user 消息上，`getHistory` → `history.jsonl` →
replay 的持久往返 therefore 完整——会话恢复后 activation 卡片可重渲染。约 45 处构造点
（lib 18 + 测试模块 21 + bin/main 1 + lib.rs 1）逐点补 `origin: None`。验证：napi 集成测试
断言 origin 随历史消息往返（`sessionGetHistory` 读回）。

**顺带修掉一处陈旧测试**（非本轮引入）：`test_http_sessions_crud_and_prompt` 的 children
断言读 `children` 键，而路由在 §6.4 的信封对齐中已改为 v2 的 `{items, has_more}`
（`mod.rs:4927`）——按「测试落后于实现先修测试」更新为读 `items`。

---

## 8. 订正轮 Batch 2（2026-09-20，用户批准三族全量；对照双参考完整移植）

> 本轮铁律：每一项都对照 **fork 退役参考**（`.tmp/v2-ref`，kap-server/klient/acp-server 与
> v1/v3 协议接线的唯一存在处）与 **upstream 官方参考**（`.tmp/v2-ref-upstream`，
> agent-core-v2 的行为出处）双向核对，bundle 消费面作第三证据。凡参考只有一处有的，
> 引用有的那一处。

### 8.1 协议投影族

**A1 `subscribe_v2` / `unsubscribe_v2` 声明 + ack 对齐（§7.5 闭环）**：
`packages/protocol` 新增对 `@moonshot-ai/transcript` 的 workspace 依赖（无环，
transcript 不依赖 protocol），`ws-control.ts` 声明两个帧的 message schema 与 ack
schema 并注册进 `clientControlOperations`（10 → 12，与 upstream `ws-control.ts`
的 `clientControlOperations` 一致）。**同时对齐 ack 形状**：fork 原发
`{session_id, agents, not_found}`（无任何参考出处），upstream `onSubscribeV2` /
`onUnsubscribeV2`（`wsConnectionV1.ts:261-320`）发 `subscribeAckPayloadSchema` 的
`{accepted, not_found, resync_required, cursors}`——Rust `subscribe_v2_ack` /
`unsubscribe_v2_ack`（`ws_protocol.rs`）重写为该形状，cursor 取
`latest_wire_event_seq`。bundle 把 ack 路由为 ignore（不约束形状），对齐无消费者成本。
**门禁修复**：`scan-parity.mjs` 两个收集正则的字符类 `[a-z_]+` 不含数字，
导致两边都对 `subscribe_v2` 隐形（报 10 而实际 12）——按「教匹配器而非弱化契约」
改为 `[a-z0-9_]+`，现报 `WS ctl 12`。

**A2 `skill_activations` 全链（§6.1 item 4 / #3832 闭环）**：
- 投影：`projection.rs` `skill_activations_of` 逐字对照 upstream
  `agentProjector.ts:2338 skillActivationsOf`——`skill_activation` 变体取
  `skillName`/`skillArgs`（camelCase，transcript 契约形状），`user` 变体取折叠的
  `skillActivations` 数组；无可用技能名返回 None（上游返回 undefined）。
- **origin 规则修正（本轮关键）**：初版实现「metadata 自带 kind 即 origin」匹配不到
  真实消费者——bundle `activateSkill` 发送的是 `metadata: {origin: {...}}`
  （origin 嵌套在 metadata 下）。改为读 `metadata.origin`（带 kind 才认），
  其余 metadata 保持 #3764 的 clientMetadata 包装。
- live 链：`MessageCallbacks` 增 `origin` 字段，`announce_prompt` 把 turn origin
  随 `event.message.created` 下发（`message_events.rs`），live 翻译器同函数投影
  （`live.rs`）——live 与 history 同源。

**A3 live `attachment_ids`**：生产路径不发 typed `TurnStarted`（`message_events.rs:179`
自承），v3 live 的 user 实体原无生产者。新增 `event.message.created`（role=user）
臂：从 `msg-u{turn}` 解析 turn，内容部件折叠为 text/media parts，附件 id 按
`MediaRef.file_id` 与 `*Url.id` 推导（内联 base64 与无 id URL 不是附件——与 history
投影同规则）；`announce_prompt` 同时带出 prompt 的媒体部件（`media_content_part`，
v2 `contentToCoreParts` 形状）。

### 8.2 引擎语义族

**B1 `reasoning_details` 重放（#3910 未移植半件 + `hidden`）**：
`ContentBlock::Think` 增 `detailsIndex` / `reasoningKey` / `hidden`
（serde camelCase，宿主 ThinkPart 形状）。重放侧 `project_message` 逐字对照 v2
`lowerMessage`（`openai/lower.ts:69-169`）：带戳部件重建 `reasoning_details` 数组
（summary/encrypted 条目），带 key 部件按 key 累积字符串字段，无戳文本归声明键
（无声明键时保持 fork 的文本兜底）；details 非空时默认键取默认字符串字段或全部
thinking。解析侧 `reasoning_details_parts` 对照 v2 `extractReasoningDetails` +
`convertReasoningDetails`：数组元素按位置盖戳，`seenReasoningContent` 后 summary
盖 `hidden`（重放保留数组条目但文本不进字符串字段——provider 不会两次看到同一
reasoning）。

**B2 `displayPaths` 协议面 + 降级恢复链（§6.1 item 17 ② 闭环）**：
- 预算省略早已实现 v2 `replaceWithMediaTag`（省略引用留 path 标签）——本轮核实。
- transcript 附件：`AttachmentSource` 三变体（契约早有，fork 只发 url）——
  `attachment_from_block` 现发 `session_media`（MediaRef）与 `file`
  （`kimi-file://` URL 解析出 id），远程 URL 保持 url；turn 实体按 v2 冷折叠
  `foldTurnOpeningInput` 语义挂 `attachment_ids`（bundle 消费 `attachment.upsert`
  与 `attachment_ids`，消费者证据成立）。
- **降级恢复链（ROADMAP 条目②亲自点名的缺失消费者）**：v2
  `nextProjectionPolicyForError`（`llmRequesterService.ts:547-610`）的完整移植——
  `is_request_too_large`（413）触发；`degrade_older_media`（保留最新 2 个，
  v2 `MEDIA_DEGRADE_KEEP_RECENT`）→ 仍被拒则 `strip_all_media`（v2
  `stripMediaPartsBySnapshot` 的快照全量形态）；替换沿用 path 标签；两级各一次，
  之后放行原错误。transform 作用于**未解析**消息（引用还认得文件，path 标签需要它），
  由 run_turn 恢复循环重新解析。warning 走 v2 的 `media-degraded` / `media-stripped`
  码与文案。测试：`a_too_large_request_degrades_then_strips_and_retries`
  （真实 turn 循环，媒体数 4 → 2 → 0）。

**B3 napi `compaction_max_attempts`**：`napi-contract.d.ts` 增
`compactionMaxAttempts`，`napi_bindings.rs` 两处 `None` 改读参数；
node-sdk `resolveCompactionMaxAttempts`（仅文件，上游未绑环境变量）+
params 透传。TUI 路径该键自此生效。

### 8.3 持久化 schema 族

**C1 interaction 实体历史源（§6.1 item 4 硬缺口闭环）**：
方案选型：ROADMAP 原列「新增表或声明 history 不返回 interaction」——实测 hub
persister 已把六种 interaction 生命周期事件全量写入 `wire_events`（第三方案，
无需新表）。落地：`sqlite_store.rs` `interaction_wire_events`（按类型选择，
journal 序）；`projection.rs` `project_interactions` 折叠为 v3 interaction 实体
（approval 的 decision 映射、TTL 清扫无 decision 读 `cancelled`、question 终态
无 answers——答案走 resolution 通道不在事件里，与 live upsert 同形状）；
history 路由与 v3 恢复页同源接入。**顺带补 live 的 question 臂**（原只有
approval，live/history 一致性）。

**C2 session_state 全字段（§6.1 item 4 部分源补全）**：
初版只读 agent_config/metadata（ROADMAP 当年只看了 sessions 表，漏看 state_entries）。
本轮对照 upstream `SessionStateAggregator`（`sessionState.ts`）补全：goal 取自
workspace store 的 goal 域（`{goal: <snapshot>}`，budget 映射对照 `feedGoal`），
modes 取 plan 域 + agent_config 的 swarm_mode（对照 `computeModes`）；
model/thinking/permission 维持。history 路由与恢复页接入（workdir 解析提升为
两者共用）。

**C3 `state_entries` session_id 迁移（P2 作用域决策）**：
真实消费者：`delete_session` 原本不级联 state_entries，agent_config/metadata
成孤儿。落地：幂等 ALTER 增 `session_id` 列 + 索引；`put_session_state` 新写路径
带属主；`delete_session` 级联列属主行 + 遗留键编码行（`agent_config`/`metadata`
的 key 即 session id）；9 个写入点迁移到新路径。测试含文件库重开（迁移不碰旧行、
旧行读回不变、删除级联双形态、workspace 行不误删）。

### 8.4 测试面修正（实现正确、旧断言失真）

session.state 进入 history/恢复页后，4 处旧断言按「测试落后于实现先修测试」更新：
`v3_history_route_serves_entities_with_paging`（三类分页各多尾部 session.state）、
三个 ws_v3 测试（恢复页尾部实体需先消费）。另修一处测试隔离泄漏的发现：
测试会话无 workspace 时 `resolve_session_workdir` 回退 CWD，读到开发者真实
`~/.kimi-code/engine-state` 的 plan 域——行为正确（生产如此），测试断言已兼容。

**验证**：`cargo test --lib` 2770 项 + 集成套件 7 组 + `cargo clippy
--all-targets --features cli -- -D warnings` + `cargo fmt --check` 全绿；
`bun scripts/scan-parity.mjs` 通过（WS ctl 12）；`packages/protocol` 617 项 +
typecheck、node-sdk typecheck 全绿。

### 8.5 订正轮补充（2026-09-20 续推，四项剩余项逐项核实后落地/证伪）

**image-format 降级臂（v2 `nextProjectionPolicyForError` 第二臂）**：
`is_image_format_error`（`media_budget.rs`）对照 v2 `isImageFormatError`
（`llm-adapter/contract/errors.ts:215`）的**状态分支**：400 + 图像格式文案
（`unsupported image url|format|type`、`does not represent a valid image`、
`could not (process|decode) (the |input )?image`、`unable to process …`、
`failed to decode (the )?image`、`invalid image( data| type| format)?`），
或 media/mime-type 字段投诉且提及 image。v2 的 provider-message 分支
（`invalid data url for image` 等）在 fork 无对应错误类，未移植（测试注释钉住
该双分支结构）。run_turn 恢复循环接入该臂：图像格式拒绝**直接 strip**
（v2 不给它 degrade 轮），与 too-large 臂共用 `media_stripped` 标志与
`media-stripped` warning；warning 文案改回 v2 原文（`Provider rejected the
media in the request; all media were omitted and the request were retried.`
——初版自拟的 "the media were stripped" 文案已更正）。测试：
`an_image_format_rejection_strips_the_media_and_retries`（媒体 3 → 0，
无 degrade 轮）。

**v1 transcript prompt 的 clientMetadata（契约字段补齐）**：
`packages/transcript` 契约的 `transcriptPromptSchema` 本就有
`clientMetadata`（`schema.ts:377`），fork 的 `TranscriptPrompt` 没有——真缺口。
落地：模型增 `client_metadata`（契约的数组形状）；投影新增 `prompt.submitted`
折叠臂（route 发布的 item 带 metadata，包成契约的单元素数组）；
`event.message.created` 臂 upsert 时**保留**已有 metadata（submission 先于
announcement 到达，upsert 是整体替换，不保留会丢）。测试钉住三种路径：
submission 带 metadata、announcement 新建（无 metadata）、同 id 时保留。

**三项核实为「非缺口」，记录以防后续重复上报**：
1. **gui_store 不迁 session_id 列**：其 key 是任意 UI 键（`theme`/`sidebar`，
   `gui_set_item` 调用方），本就是守护进程级 UI 状态，无会话归属——C3 的
   级联不含它是正确决策，不是遗漏。
2. **napi prompt 路径不加 origin 载体**：`TurnRequest::user` 硬编码
   `{kind: "user"}`，但 `TurnEvent::Started` 的 origin 在生产路径**无消费者**
   （activity 是测试构造、state_store 折叠忽略、turn_events 是测试）；
   napi 会话不落 turn 记录也不由 v3 history/live 服务——加字段是投机，
   按「无消费者不加」记录。
3. **v1 transcript 的 prompt 实体不投影 skill_activations**：契约的
   `transcriptPromptSchema` 本就没有该字段（skill_activations 只在 v3 的
   user 实体与 live 投影存在）——此前「上游 coreEventMap 有」的说法不成立，
   实际那是 live 投影器（agentProjector），不是 v1 transcript 契约。

**验证**：`cargo test --lib` 2772 项 + 集成 7 组 + clippy + fmt 全绿；
scan-parity 通过。

### 8.6 交付前自审（2026-09-20）发现并补齐的缺口

**v3 全局 lane 不折叠 workspace 生命周期（v1/v3 真实不一致，本轮补齐）**：
自审发现 v1 lane 有 `event.workspace.created/updated/deleted` 生产者
（`mod.rs:3882/4014/4040`，workspace CRUD 路由发布），而 v3 全局 lane 只折叠
config/config.warning/model_catalog/plugin——v3 客户端永远看不到工作区生命周期。
（ROADMAP 旧记“workspace 无生产者”不准确，生产者一直在，缺的是 v3 折叠。）
落地：对照 upstream `globalTranslator.ts:45-80`——created/updated 用事件载荷
（fork 的 v1 载荷即完整 WorkspaceSummary = v3 WorkspaceInfo 字段集）；
deleted 只带 id+root，实体取自**每连接缓存**（connect 时从 store seed，
上游同款），缓存未见过时用上游的合成 fallback（root basename 作 name、
删除时刻作双时间戳、session_count 0）。测试：
`workspace_lifecycle_folds_into_the_workspace_entity`（created → deleted 走缓存
→ 未见过走 fallback）。kimi-inspect 按设计忽略全局消息（`store.ts:22`），
新实体无消费方影响。

**自审确认的两项既有状态（非本轮引入，记录免重复上报）**：
1. `bun run lint` 的 3 个 error 均在本次未改动的文件（`node-sdk/src/types.ts`
   的索引签名 any、`tui/controllers/session-event-handler.ts` 的 import 顺序、
   `oauth/src/storage.ts` 的 require-await）——仓库既有状态；本轮改动的 6 个
   TS 文件单独 lint 0 error。
2. root typecheck 全包通过（sdk / protocol / kimi-code / vscode / inspect）。

**仍未覆盖的原始清单项（一项，需用户决策）**：
models.dev 代理面（抓取 + 缓存 + 快照回退）——ROADMAP #3909 起即标注“独立工盘”，
不在订正轮范围；fork 目录保持内置静态列表 + base_url 已按 v2 item 形状暴露
（`mod.rs:1761` 的诚实声明）。如需推进请单独指示。

**验证**：`cargo test --lib` 2773 项 + 集成 7 组 + clippy 0 error + fmt +
scan-parity 全绿。

### 8.7 models.dev 代理面（2026-09-21，用户批准推进；对照 v2 fork 版 + 官方版完整移植）

§8.6 记录的待决策项落地。v2 参考：`agent-core-v2/src/app/kosongConfig/
{modelsDevUpstream,modelsDev,modelsDevImportService}.ts` +
`kap-server/src/routes/modelCatalog.ts`（import 路由 770-830 行）；
bundle 消费证据：`dist-web/assets/index-DusVyqlT.js` 的 `importCatalogProvider`
（POST `/providers:import_catalog`，body `{catalog_id, api_key?, base_url?, id?}`，
返回 `{provider, models_imported}`）。

**新模块 `server/models_dev.rs`**（v2 三文件对照移植，12/12 单测）：
- fetch/cache：`MODELS_DEV_URL` + 10min TTL + in-flight 去重（OnceCell，
  失败即撤 cell 让下个请求重试）+ stale 回退（v2 `fetchAndCache`）。
- wire 推断：显式 type（KNOWN_WIRE_TYPES 六种）→ npm/id 推断
  （anthropic/claude、vertex、google/gemini、openai）→ openai 默认；
  bedrock/cohere 为 proprietary-sdk 拒绝；未知显式 type 为
  unknown-explicit-type 拒绝。
- base_url 三级：用户 override（anthropic 剥尾 `/v1`）→ catalog `api`
  （占位符 `${}` 视为无）→ needs-base-url（默认 npm 除外）。
- 模型过滤：usable-chat-model（output 含 text、非 deprecated/alpha、
  非 embedding 标记）+ context>0；capability 映射 modalities/reasoning_options
  （effort 档位、none  off_effort、null 档位、toggle、always_thinking=
  有档位且无 off 且无 toggle）；interleaved.field → reasoning_key；
  limit.input 封顶后为 max_input_size；provider override（bedrock/cohere
  drop、anthropic 协议改写 base_url）。
- always_thinking 在 anthropic/kimi 线上丢弃（v2
  `wireHasProtocolThinkingDisable`，本轮补上，§8.6 时记为偏差）。
- item 投影（`provider_item`/`provider_items`）与 record 投影
  （`model_write`，always_thinking 时 thinking→always_thinking 重命名，
  fork 引擎两拼写均读——`config/mod.rs:1489/1527`）。

**路由（`server/mod.rs`）**：
- `GET /catalog/providers` 与 `/catalog/providers/{id}`（及旧别名
  `/providers/catalog`）改代理：cache 命中走映射，fetch 失败走 built-in
  快照；未知 id 404。
- `POST /providers:import_catalog`：catalog_id 必填（40001）→ entry 不存在
  40412 → resolve 失败/needs-base-url/无可用模型/id 不合模式均 40001 →
  OAuth-managed provider 40003 → 写 `[providers.*]`（type/base_url/
  api_key/api_key_env）+ 重建该 provider 的 `[models.*]` 别名 +
  default_model 未设时种首个别名 → 201 `{provider, models_imported}`。
  落盘走 `config::write::update_config`（与 provider CRUD 一致，
  §8.6 决策 3 的"仅内存"据此修正为本地既有写路径模式），随后
  `publish_config_changed(&["providers","models"])`。

**built-in 快照改为 models.dev 原始形态**（v2 `BUILT_IN_MODELS_DEV_JSON`）：
moonshot/anthropic/openai/google 四条 entry 经同一 `provider_items` 投影，
取代原手写 item 列表——能力词汇随之从 ["tools","multimodal"] 变为 v2 的
image_in/thinking/tool_use（bundle 与引擎读的均是后者，
`llm/http.rs:971`、`media_resolver.rs`）。测试 3 组：
`catalog_routes_fall_back_to_the_builtin_when_the_fetch_fails`、
`import_catalog_writes_the_provider_and_its_aliases`（含 re-import 语义）、
`import_catalog_rejects_the_unimportable`（40412/40001×5/40003）。

**记录在案的偏差**：
1. credential 从简：接受请求体 `api_key`/`api_key_env` 直写，re-import 时
   无新值则保留旧 credential；未移植 v2 `reconcileProviderCredentialUpdate`
   的 env 存在性 eager 校验（fork 在请求时解析 api_key_env）。
2. 错误码按 v2 编号入 Rust envelope（docs 与 bundle 的契约）：
   CATALOG_IMPORT_INVALID=40004、REGISTRY_IMPORT_INVALID=40005、
   CATALOG_ENTRY_NOT_FOUND=40417（PROVIDER_OAUTH_MANAGED=40003 已有）；
   TS protocol 码表不承载 provider 路由码（40003 同样只在 Rust 侧）。
   CATALOG_UNAVAILABLE(50004) 不会发生（built-in 兜底）。
3. `config/write.rs` 的 `ProviderWrite`/`ModelAliasWrite` 补全
   api_key_env/max_input_size/reasoning_key/off_effort/base_url/source 字段
   （读侧 ModelAliasConfig/ProviderConfig 早有或补上，写侧补齐）。

**验证**：`cargo test --lib` 2788 项 + clippy 0 error + fmt +
scan-parity 全绿 + protocol 565 项。

### 8.8 自定义 registry 导入 + refresh（2026-09-21，用户批准完整移植；§8.7 偏差 2 关闭）

§8.7 把 `import_registry` 记为不移植；用户复查后批准**完整移植**
（import + refresh 分支），参照 v2 `modelsDevImportService.doImportCustomRegistry`、
oauth 包 `custom-registry.ts` / `refreshProviderModels.ts` 分支 3，以及
kap-server `handleImportRegistry`（bundle 与 `docs/en/reference/server-api.md`
的 import_registry 章节自此有真实实现）。

**新模块 `server/custom_registry.rs`**（12/12 单测）：
- `fetch_registry`：Bearer 鉴权、15s 超时、10MB 响应上限（chunk 累加）、
  per-entry 校验（id/name/api/type∈{anthropic,openai,openai_responses,kimi}/
  models 必备，非法条目跳过并 warn）、错误信息提取上游 message 并截断 300 字。
- `apply_entries`（import 路径）：同 URL 且上游已消失的 provider 连别名删除
  （URL 是稳定身份），随后 remove-then-apply；default 指向被删 provider 时
  清除（v2 `removeCustomRegistryProvider`）；`seed_default_when_unset` 用
  apply 前的 default 判断（v2 `hadDefault` 语义）。
- `apply_entry`（refresh 路径）：不预删，`write_merged_alias` 合并——用户手加
  字段、`overrides` 表保留，capabilities 取并集（v2 `mergeRefreshedModelAlias`）；
  上游消失的别名按 provider 删除（不限 key 形状）。
- `credential_env_hints` / `model_count` / `RegistrySource::from_provider`。

**路由**：`POST /api/v1/providers:import_registry`——url 必填（40001）；
key 取请求值→同 URL 已存值→空（key 轮换安全）；fetch 失败/空 registry →
40001（含上游状态与消息）；OAuth-managed 冲突 → 40003；201
`{providers, models_imported, credential_env}`。

**refresh 分支 3**（`provider_refresh.rs::refresh_custom_registries`）：
按 source URL 分组（跳过 managed provider），`fetch_from_sources` 依次尝试
组内各 key 直到成功（v2 `fetchCustomRegistryFromSources`，直接单测钉住重试）；
未 scope 时同步组内全部 provider 并拉入上游新增；先分类后写盘——全部未变则
不动配置文件；`scope == "oauth"` 在分支 3 之前返回（v2 门控位置）。
changed/unchanged/failed 按 v2 形状（model id 计数）。

**config 面**：`ProviderConfig.source` / `ProviderWrite.source`（sub-table
落盘 `[providers.<id>.source]`，读侧不再丢 blob——否则 refresh 无从发现）。

**测试**：模块 12 例（校验/能力与 context 解析/ vanished 删除/合并保留/
source 往返/credential hints）；路由 2 例（双 provider + 坏条目跳过 +
Bearer 到达 + re-import 消失清理；40001×3/40003）；refresh 6 例（新增模型、
二次刷新 unchanged 且不重写文件、key 轮换、scoped 只动目标、vanished 删除
连带 default、fetch 失败报错不动配置、oauth scope 门控）。

**验证**：`cargo test --lib` 2804 项 + clippy 0 error + fmt。

### 8.8 cron 注册表读取（2026-09-21，接手项：SDK getCronTasks 不再是桩）

**语义前提（用户确认，实现不得违反）**：cron 注册表是 **workspace 级**
（state-bridge 的 cron 域不带 session_id），所以触发的任务跑在该 workspace
当前活着的会话里，而不是「创建它的那个会话」——现有 dispatcher
（`napi_bindings.rs::spawn_cron_dispatcher`，按 `live_session_for_workspace`
取活会话）已是这个语义，本轮不动。`CronEntry.session_id` 只是创建路径的记录
字段，不过滤注册表。

**落地**：
- `cron/scheduler.rs` 新增 `next_fire_for_entry(entry, from_ms, tz)`：
  单条目后抖动下次触发（v2 `getNextFireForTask`），与 `tick` 同一
  jitter 推导；聚合的 `next_fire_at` 与其一致（单测钉住）。
- napi 新增 `native_cron_next_fire(entry_json, from_ms)`（99 项，
  napi-contract.d.ts / index.native.d.ts / index.native.cjs 同步）：
  host 无法复刻解析器、本地时区与抖动推导，照 `native_read_engine_state`
  的先例问引擎。
- SDK `sdk-rpc-client-native.ts::getCronTasks` 不再是桩：经
  `nativeReadEngineState(workDir, 'cron')` 读 workspace 注册表（与
  `getTodos` 同一模式），映射 `CronTaskSnapshot`
  （id/cron/recurring 默认 true/createdAt/lastFiredAt/nextFireAt），
  空域/坏 JSON/非数组一律 `{tasks: []}`。TUI 无消费点，未加 /cron 命令
  （用户明确「没动」）。

**测试**：`next_fire_for_entry_answers_per_entry`（Rust）；
`nativeCronNextFire` 4 例（napi 集成，真 addon：未来时刻/坏表达式/坏
JSON/一次性）；`session getCronTasks`（node-sdk，stub HOME/USERPROFILE 到
临时目录后按 engine-state 布局种子注册表，断言映射与 nextFireAt）。

**验证**：`cargo test --lib` 全量 + napi 集成 + node-sdk 全量 + fmt +
clippy + scan-parity（napi 98→99 两侧同步）。

### 8.9 引擎端点解析订正（2026-09-21，接手项：baseUrlEnv 通道 + 两条附带缺口）

**背景**：v2 `resolveModelConnection`
（`human/llm/protocol/connection.ts:36`，四个 protocol base 的 `generate()`
里调用）解析 `baseUrl = model.baseUrl ?? read(baseUrlEnv) ?? defaultBaseUrl`；
fork `extract_native_llm` 只有 google 常量，不读任何 baseUrlEnv——
`docs/en/configuration/providers.md` 与 `env-vars.md` 承诺的 per-type
env 键名与默认端点在 native 引擎不存在（kosong 侧自上游 PR #1269 起有
`GOOGLE_GEMINI_BASE_URL` / `GOOGLE_VERTEX_BASE_URL` fallback，引擎侧没有）。

**落地 1（endpoint 声明表，`config/mod.rs`）**：
`endpoint_declaration(provider_type)` + `endpoint_fallback_base_url`，
链接顺序为 alias.base_url → provider.base_url → env → default：

| provider type | baseUrlEnv | default |
| --- | --- | --- |
| `kimi` | `KIMI_BASE_URL` | `https://api.moonshot.ai/v1` |
| `anthropic` | `ANTHROPIC_BASE_URL` | `https://api.anthropic.com`（SDK 默认） |
| `openai` / `openai_responses` / `openai-responses` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| `google` / `google-genai` / `gemini` | `GOOGLE_GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com`（原常量） |

env 空串视为未设置（`non_blank`，与 v2 `read` 同义）；默认值经
`normalize_base_url` 归一（anthropic 补 `/v1`、google 补 `/v1beta`）。
`vertexai` 故意缺席：引擎无 Vertex wire protocol（Vertex provider 现落
openai protocol），认 `GOOGLE_VERTEX_BASE_URL` 会把 host 层服务正确的流量
拉进形状错误的请求——Vertex 留在 host 代理。api key 侧不加 type 派生
env 读取：fork 文档约定凭证键名只走 config 文件（`env-vars.md`），
`api_key_env` 显式通道不变。

**落地 2（api_key_env 透传，两处丢弃）**：
`server/engine.rs::resolved_native_llm` 与 `repl/mod.rs` 的
`NativeLlmConfig` 构造把 `native.api_key_env` 丢成 `None`（源自
`d5511a18da` 未提交改动快照，非设计决策；`main.rs:140` 同场景透传）——
env 绑定供应商经 server 路径（`session_spec` / `llm_for_model`，即
`kimi web`）和 REPL（`kimi-agent --repl`）会带空 credential 发请求。
两处均改为透传，transport 请求时读变量的既有语义不变。REPL 的
`auth_provider: None` 不动：REPL 没有 host token 通道，OAuth 在该界面
本就不可用（透传只会把静默 401 变成显式报错）。

**落地 3（`openai_responses` protocol 匹配）**：protocol 匹配不认
p_type `openai_responses`（落 Chat Completions）——v2 注册表
id→baseProtocol、kosong `ProviderType`（"the host config layer keys
provider selection off it"）、docs `providers.md`、custom_registry
`ALLOWED_PROVIDER_TYPES` 都约定该 type 走 Responses。补匹配臂。

**测试**：config 5 例（anthropic/openai/kimi/google 各自
env→default→blank→declared 优先级；未声明 type 无 base_url 仍不解析）；
engine 1 例（env 凭证通道透传，`session_model_keeps_the_env_bound_credential_channel`）。

**验证**：`cargo test --lib` 2811 通过；
`cargo test --no-default-features --features cli,workflow-js` 2804 + 集成
全绿；`cargo clippy --all-targets --features cli -- -D warnings` 0；
fmt 干净。

**文档**：`env-vars.md` 双语补例外段——直接由引擎运行会话的界面
（`kimi acp`、`kimi web`）在供应商未声明 `base_url` 时，从 shell 读
`*_BASE_URL` 作备用、再退到类型默认端点；warning 里「唯一例外」措辞
同步（`GOOGLE_APPLICATION_CREDENTIALS` 不再是唯一走系统环境变量的键）。
此为已批准偏差：引擎按 v2 读 process.env，TS host 层维持 config-file-only。

### 8.10 未决清单复核（2026-09-21）：5 条「未闭环」实已落地 + vertexai protocol 归位

**复核方式**：按 §6.0 自己立规矩——「复核对账时必须拿代码验证裁定，不能信任
note 的措辞」——把 §6.1/§7 里未划掉的条目逐条回代码里查。结论：**5 条的
「未闭环」表述已过期，实现都在，只是没人回写 ROADMAP**。这正是该节预警的
「note 过期让门禁/对账失真」的实例，因此本轮不只补实现，也把裁定改判。

**已由代码证伪「未闭环」的 5 条**（均附落点，未新写代码）：

1. **§6.1-11 #3750 的 napi 缺口**（原注：「napi 路径（TUI）没有对应的 napi
   参数……不在本次范围内」）。现状：`JsRunTurnParams.compaction_max_attempts`
   （`napi_bindings.rs:840`）存在且透传（`:2288`、`:2614`）；
   `napi-contract.d.ts:367` 声明 `compactionMaxAttempts?`；
   `node-sdk` 侧 `config-local/schema.ts:215`（zod，min 1）+
   `native/native-llm-resolver.ts:634-641`（file-only 解析，下限 1）+
   `sdk-rpc-client-native.ts:1752,1827`（读 config 并塞进 runTurn 参数）。
   TUI 走 SDK 原生客户端，故该键在 TUI 下已生效。allowlist 侧对应
   `.changeset/upstream-config-behaviors-3750-3785-3681.md`。
2. **§7 #3843 skill scopes**（原注：「本引擎的技能目录不产出 scopes，
   全仓 rg '"scopes"' 无命中」）。现状：`skills/mod.rs:27` 的
   `SkillSummary.scopes: Option<Vec<String>>` + `parse_scopes_value`（`:37`，
   frontmatter 括号列表，空列表归 None），并已出到宿主面——
   `acp/mod.rs`、`callbacks.rs`、`prompt/skills_renderer.rs`、
   `server/debug.rs`、`server/v3/projection.rs`、`session/mod.rs` 均引用；
   TS 侧 `node-sdk/src/types.ts:486` 的 `scopes?: readonly string[]` 与
   TUI 过滤逻辑早已就位。**已端到端接通。**
3. **§6.1-17 #3784 ① 上传缓存不落库**（原注：「fork 只在解析器的进程内
   记忆里缓存」）。现状：`llm/media_resolver.rs:256` 的
   `upload_cache: Option<Arc<SqliteSessionStore>>`（持久层，
   `UPLOAD_CACHE_DOMAIN = "media_upload_cache"`，`:45`），且
   `server/engine.rs:318` 在 daemon 路径 `.with_upload_cache(store.clone())`
   装配。重启后复用 provider 侧上传已实现。
4. **§6.1-17 #3784 ② displayPaths 未接到 UI**（原注：「没有把引用 → 保存路径
   映射送到 TUI 的协议面」）。现状：`server/transcript/project.rs` 把存储的
   媒体引用折成 file-sourced attachment（客户端可经 daemon file API 解析保存
   路径），测试 `a_stored_media_reference_folds_into_a_file_sourced_attachment`
   （`:1662`）钉住。**已接通。**
5. **§6.1-24 #3909 的「models.dev 代理面仍未建」**：§8.7 已完整落地
   （models.dev 代理面，2026-09-21，对照 v2 fork 版 + 官方版），该括号注
   属于写 §8.7 之前的历史表述。

**本轮真正修的一条（v2 ↔ Rust 不一致）**：`type = "vertexai"` 的 protocol
归位。`server/model_catalog.rs:33` 把 `vertexai` 映射为 `google-genai`，
而 `config/mod.rs` 的 `extract_native_llm` protocol 匹配**没有这一族**——
Vertex 供应商落进 Chat Completions，同一引擎对同一类型给出两个答案，
且文档（`docs/{en,zh}/configuration/providers.md` 的 vertexai 节）说明
本 fork 的 Vertex 是 Gemini-mode、可走代理端点。修法：protocol 匹配补
`vertexai` → `google-genai`（alias 级 `Some("vertexai")` 与 provider 级
`p_type == "vertexai"` 两处）。**endpoint 声明表仍刻意不含 vertexai**——
引擎没有 Vertex wire protocol（区域化 `*-aiplatform.googleapis.com` 无单一
默认主机、无 ADC），认 `GOOGLE_VERTEX_BASE_URL` 只会把 host 层服务正确的
流量拉进形状错误的请求；只有显式声明 `base_url` 才解析。
测试：`config::tests::vertexai_provider_type_resolves_the_google_protocol`
（显式 base_url → google-genai + `/v1beta` 归一；裸配置不解析）。
验证：`cargo test --lib` 2812 通过、fmt、clippy `-D warnings` 0。

**复核后仍然开放的**（均为结构性留白，非缺口）：
- **`capability` 事件**：v2 自己也只有声明没有生产者——`CapabilityChanged`
  在 `agent-core-v2/src/app/capability/capabilityEvents.ts` 定义了
  `event.capability.changed`（`capability_id` + `install` 进度），kap-server
  有中继臂，但全仓**找不到 `new CapabilityChanged`**，即上游从不发它；
  且本引擎的 capability 列表是 ACP initialize 的静态集合，没有可广播的
  变更语义。无可移植，`ws_v3.rs` 模块头的留白说明已改为这个更准确的表述。
- **#3910 的 `reasoning_details` 盖钉**（刻意不移植：`ContentBlock::Think`
  没有 detailsIndex 身份，机械移植会对已重放字段二次重放）。
- ~~#3532 的 `workspace` 事件无生产者~~ **同样是过期表述，本轮证伪**：
  `server/mod.rs` 四个变更点（create `:4147` / set_trusted / update_name
  `:4279` / delete `:4305`）都在 global lane 发布
  `event.workspace.created|updated|deleted`，`ws_v3.rs::translate_global`
  的 workspace 臂（`:411` 起）按连接缓存折成 `WorkspaceMessage`
  （created/updated 带全量记录、deleted 只带 id+root 并从缓存取实体，
  缓存没见过时用上游的合成回退），测试
  `server::tests` 的 workspace 生命周期 1/2 两步 + `ws_v3` 12 项全绿。
  `ws_v3.rs:373` 那句「workspace lane 与 plugin 事件尚不存在」的注释
  已就地更正（折叠臂就在其下方 40 行）。

### 8.11 跟随上游 revert v3 扁平实体协议（2026-09-21，用户决策「不值得」）

**上游动作**：`2502d2157`（2026-09-19，随 **2.0.2** 发布）整体 revert 了 `64505e36e`
（2026-09-10，随 **0.43.0** 引入）的 v3 扁平实体消息协议。PR #3920 给出的理由：
v3 是「先平行落地、再拆旧面」迁移的前半程，而**后半程（拆 v1 WS + transcript）
始终没落地**，于是 main 长期并存两套协议栈，而 v1 是官方客户端（CLI、desktop）
与仓内消费方唯一在用、唯一在收修复的面；此后每个 kap-server 改动都要同时伺候两套。
上游定性：v3 没有 shipped client 消费，删掉用户无感（故不需要 changeset）。

**用户决策**：v3 的优势（live 与 history 同形状、实体 id 客户端可自算、按 turn 分页、
全局 lane 实体、定义完整的边缘词汇）全部是**客户端复杂度**收益，fork 里只有
kimi-inspect 一个客户端兑现；而最大的消费方 dist-web 是说 v1 的**同步预构建
bundle**、fork 无权改其协议，所以单一协议面永远不可达。结论：不值得独养一套协议。

**落地（删）**：
- 引擎：`server/ws_v3.rs`、`server/v3/`（entity/history/live/messages/mod/
  projection/route 七文件）、`v3-message-contract.json`、`server/mod.rs` 的
  history 路由臂（`extract_session_action(p, "history")`）与模块声明、
  `http.rs` 的 v3 升级臂、`engine.rs` 的 `in_flight` 注册表（字段 +
  `record_step` / `in_flight()` / turn 内的 step tracker 闭包 + turn 末清除；
  `MessageCallbacks::with_step_tracker` 本身是多处使用的通用机制，保留）、
  `publish_config_warnings` 文档注释里的 v3 措辞。
- 契约：`packages/protocol/src/v3.ts` + `./v3` 子路径导出 + `index.ts` 的
  `export * from './v3'` + `src/__tests__/v3.test.ts`。
- 门禁：`scripts/scan-parity.mjs` 的 v3 维度（契约加载、`collectRustV3Messages`、
  `readUpstreamV3Sources`、main 里的双向检查块、汇总行的 v3 段）。

**落地（kimi-inspect 回退 v1 transcript 模型，用户选 A：audit 面板重写保留）**：
- `transcript/ws.ts` 重写为 `/api/v1/ws` 客户端：`client_hello` →
  `subscribe_v2 {transcript:{agent:'delta'}, transcript_since:{agent:seq}}` →
  `ack` → `transcript.reset` + `transcript.ops`；控制帧按 `kind` 分发（ack/error），
  数据帧按 `type`；重连带上已应用的 seq，reset 把该 agent 的游标归零。
- `transcript/store.ts` 重写：持有一个 `AgentState`，`applyReset` / `applyBatch`
  经 `applyOperation` 折叠后投影；导出面（`ChatState` / `TimelineEntry` /
  `hasTurnId` / `newestTerminalStepId` / `oldestTurnId`）不变，ChatView 零改动。
- `transcript/model.ts`（新）：本地视图模型 + `projectChatState` 投影
  （turn/step/text/thinking/tool/notice/marker/taskref → 七种 TimelineMessage），
  `meta` 供徽章读取。
- `transcript/api.ts` 删除（分页 history 路由没了）；`Inspector` 的 Plan 查询
  改读 ChatView 经 `onStateChange` 上报的 timeline（`plan.ts` 从 ExitPlanMode
  工具调用 + approval interaction 推导，与上游 revert 后的 kimi-inspect 同源）；
  ChatView 的翻页链路（sentinel / loadOlder / anchor / jump 的 while）整条移除
  ——冷重放已含全量。
- `audit/trail.ts` 重写：`rest` 条目 → `ops` 条目（reset/live/replay 三种 mode，
  记录 op 批次），`ws` 条目记录 reset/ops 帧；`AuditPanel` / `serialize` 随之适配，
  Diff/State/Event 三视图与时间线滑块全部保留。
- 测试：`transcript.test.ts` 重写为 22 例（握手/游标/reset+ops 折叠/append 的
  offset 语义/tool 增量是整帧 upsert/items.remove 截断/级联/plan 推导），
  `audit.test.ts` 14 例、`StateTree.test.tsx` 5 例随之适配。

**验证**：`cargo test --lib` 2728、`--no-default-features --features cli,workflow-js`
2721 + 集成全绿；fmt、clippy `-D warnings` 0 error；`bun run lint` **0 error**
（基线为 1）；`scan-parity` OK（config 31 键两侧同步，v3 维度移除）；
kimi-inspect 106、protocol 555、全量 `bun run test` 492 文件 / 8350 通过。

**与上游的差异（有意）**：fork 的 v1 lane 本就是 `subscribe_v2` + transcript ops
（与上游同词表），因此回退后两边仍同构；fork 额外保留了三样上游 revert 时没有的
东西——audit 面板（重写在 ops 批次上）、Plan 查询（从 timeline 推导）、以及
`transcript/model.ts` 这层本地视图模型（上游直接渲染 transcript item）。
