# kimi-agent (Rust 原生引擎) 替代 v2 战略路线图与全量子系统技术对齐矩阵

> **战略总目标**：**彻底删除 `packages/agent-core-v2`（下称 v2）**。
> 
> 本路线图唯一的终态判定标准是：**v2 从 Monorepo 中物理消失，且 `apps/kimi-code`、`packages/kap-server` 与 `packages/klient` 完全由 Rust 原生引擎驱动**。
> 功能等效只是迁移期的过渡验收手段，不是终点。

---

## 1. 全架构 10 大子系统技术深度对齐矩阵（TS 源码 vs Rust 引擎）

本矩阵从零系统性复盘 GitHub 上 TypeScript 核心源码（覆盖 `agent-core-v2`（1,544 个文件）、`kap-server`（314 个文件）、`klient`（94 个文件）、`acp-server`（49 个文件）、`kosong`（41 个文件）、`transcript`（25 个文件）、`minidb`（58 个文件）等全仓 1,400+ 个 TS 源文件），对标 Rust 引擎（`packages/kimi-agent`，含 `src/native/` 原生工具层）的实现深度（文件数于 2026-09-15 按 `upstream/main` 实际统计复核）：

### 板块 1：核心 Turn 循环与生命周期管理

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **Turn 主循环驱动** | `agent-core-v2/src/agent/loop/loopService.ts`<br>`stepRequestQueue.ts` | `kimi-agent/src/turn_loop/run_turn.rs`<br>`src/turn_loop/turn_step.rs` | ✅ **100% 原生** | Rust 具备完全自主的 step 循环驱动，单轮支持最大步数约束（None = unbounded 镜像 JS）、TokenUsage 5 维细分累计、`finish_reason` 映射（length/max_tokens → MaxTokens、content_filter → Filtered）。通过 `check:engine-zero-js-loop` 验证 JS 循环 11 个函数零调用。 |
| **并发工具调度** | `agent-core-v2/src/agent/loop/toolExecutor.ts` | `kimi-agent/src/turn_loop/tool_scheduler.rs` | ✅ **100% 原生** | 基于 `infer_tool_accesses` 静态推断资源冲突，构建并发批次。写写冲突、写读冲突严格串行化，只读工具并发放行；Bash 命令推断为工作区整树写访问（`write_tree_access`）。 |
| **故障退避与重试** | `agent-core-v2/src/agent/stepRetry/stepRetryService.ts` | `kimi-agent/src/turn_loop/retry.rs` | ✅ **100% 原生** | 指数退避加 ±25% Jitter（两侧均非 Full Jitter），错误分类对齐 v2 `isRetryableGenerateError`：可重试集 {408, 409, 429, 500..=599}（Rust 额外含 425），429 配额/欠费文案豁免（kimi-errors.ts 判据）；重试次数可经 `RunTurnInput.max_attempts` 配置，默认 10 对齐 v2 `DEFAULT_MAX_RETRY_ATTEMPTS`。 |
| **后台异步任务** | `agent-core-v2/src/agent/loop/nativeBackgroundAgentTask.ts` | `kimi-agent/src/storage/task_runner.rs` | ✅ **100% 原生** | 原生 `tokio::spawn` 托管后台任务，生命周期状态机为 Running/Completed/Killed（非 v2 的 Pending/Running/Completed/Failed），支持协作取消与 5s 宽限。后台 bash/子代理任务全部经 TaskRunner 注册（TaskStop/TaskOutput 全覆盖），并携带父 session 与任务类型向对应 WebSocket lane 广播 `event.task.created/completed` 与 `background.task.started/terminated` 双词汇生命周期事件。 |

### 板块 2：多 Provider LLM 抽象与流式传输

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **OpenAI 兼容协议** | `packages/kosong/src/providers/openai/`<br>`openai-legacy.ts` | `kimi-agent/src/llm/openai.rs`<br>`src/llm/wire.rs` | ✅ **100% 原生** | Chat Completions SSE 流式解析、原生 Tool Calls 增量合并、自定义请求头（customHeaders）、`reasoning_effort` 结构化透传、Audio/Video 媒体块原生编码。 |
| **OpenAI Responses** | `packages/kosong/src/providers/openai/openai-responses.ts` | `kimi-agent/src/llm/openai_responses.rs` | ✅ **100% 原生** | 对齐 OpenAI Responses 协议的请求投影与流式 Delta/failed/error 事件解析。两侧均无服务端会话状态追踪（TS 侧 store:false、无 previous_response_id），Rust 亦未请求 `include: reasoning.encrypted_content`。 |
| **Anthropic Messages** | `packages/kosong/src/providers/anthropic/` | `kimi-agent/src/llm/anthropic.rs` | ✅ **100% 原生** | 完整实现 Anthropic 4-Slot 提示词缓存断点注入（`cache_control: {"type": "ephemeral"}`），支持 `thinking.budget_tokens` 与思考块提取，自动恢复上下文溢出。 |
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
| **文件读写与修改** | `agent-core-v2/src/agent/tools/os/`<br>`read/`, `write/`, `edit/` | `kimi-agent/src/native/read.rs`<br>`write.rs`, `edit.rs` | ✅ **100% 原生** | Read：行范围（`line_offset`/`n_lines`，上限1000行）、截断（2000字符）、编码侦测与媒体回退；Write：支持 append/overwrite 与原子写入；Edit：严格唯一匹配断言与 replace_all 模式。 |
| **文件搜索与模式匹配**| `agent-core-v2/src/agent/tools/os/`<br>`grep/`, `glob/` | `kimi-agent/src/native/grep.rs`<br>`src/tools/core_tool_defs.rs` + `src/tools/mod.rs` | ✅ **100% 原生** | Grep：内置 ripgrep 核心正则引擎，开启 `--hidden` 且完整移植 `isSensitiveFile` 敏感文件过滤与脱敏提示；Glob：基于 `ignore`/`globset` 遵循 `.gitignore`，目录折叠。**2026-09-15 更正路径**：`Glob` 工具的定义与派发在 `src/tools/core_tool_defs.rs` / `src/tools/mod.rs`，而 `src/native/glob.rs`（55 行）只是 MCP 工具名过滤与权限模式匹配用的 `glob_matches_any` 辅助，不是该工具的实现。 |
| **命令执行与环境** | `agent-core-v2/src/agent/tools/os/bash/`<br>`packages/kaos/` | `kimi-agent/src/native/bash_spawn.rs`<br>`kimi-agent/src/tools/kaos.rs` | ✅ **100% 原生** | 原生执行平台 Bash（Windows 优先定位 MSYS2/Git Bash，拒绝 cmd），支持超时强制 Kill（默认 60s/上限 300s）、256KB 输出截断、非零退出码精确传播、实时输出流向 `tool.progress` 广播。**2026-09-15 更正路径**：真正的一次性命令执行在 `src/native/bash_spawn.rs`（618 行）；`src/native/bash.rs`（39 行）只保留超时常量与 `kill_process_tree`。 |
| **沙箱隔离策略网关** | `agent-core-v2/src/workspace/sandbox/sandbox.ts` | `kimi-agent/src/tools/sandbox.rs` | ✅ **100% 原生** | P155 SandboxGuard：支持 Off / ReadOnly / WorkspaceWrite。规范化 Windows 盘符大小写不敏感匹配，越界写操作与命令执行 Fail-Closed 拦截，只读操作安全放行。 |

### 板块 4：权限决策引擎与 G-6 否决链全量收敛

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **权限决策模型** | `agent-core-v2/src/workspace/permission/`<br>`permissionGateService.ts` | `kimi-agent/src/permission/mod.rs`<br>`src/callbacks.rs` | ✅ **100% 原生** | 完备实现 Manual / Auto / Yolo 三大模式及完整策略链求值，支持独立运行本地判定与宿主双向委托（Fail-Closed 兜底，绝不发生二次弹窗）。 |
| **G-6 #1: Plan 文件保护**| `agent-core-v2/src/features/plan/` | `kimi-agent/src/tools/plan_mode.rs` | ✅ **100% 原生** | 计划模式激活期间，严格拦截除指定计划文件外的任意写操作与破坏性工具。 |
| **G-6 #2: 工具重复调用去重**| `agent-core-v2/src/agent/toolDedupe/` | `kimi-agent/src/tools/tool_dedupe.rs` | ✅ **100% 原生** | 识别并阻止同一 turn 内相同参数的只读工具重复执行，直接复用历史缓存。 |
| **G-6 #3: 盲写陈旧防护**| `agent-core-v2/src/features/staleGuard/` | `kimi-agent/src/tools/stale_guard.rs` | ✅ **100% 原生** | 写操作前置校验文件自读取以来的修改时间戳（mtime），防止并发冲突与盲写覆盖。 |
| **G-6 #6: PreToolUse 钩子**| `agent-core-v2/src/features/externalHooks/` | `kimi-agent/src/tools/external_hooks.rs` | ✅ **100% 原生** | 在工具执行前同步触发用户自定义外部钩子，超时（Fail-Closed）或返回非零时立即拦截。 |
| **G-6 #7/#8: Goal 准入与过期**| `agent-core-v2/src/features/goal/` | `kimi-agent/src/tools/goal_guard.rs` | ✅ **100% 原生** | 阻断在不合法状态下启动新 Goal，并在检测到 Goal 快照过期时强制拒绝工具调用。 |
| **G-6 #12: Tower TodoList 否决**| `agent-core-v2/src/features/tower/` | `kimi-agent/src/tools/tower/mod.rs` | ✅ **100% 原生** | P154：Tower 模式下即时否决子代理调用 TodoList，防止舰队任务串行化。 |
| **G-6 #13: Worker 工作区写隔离**| `agent-core-v2/src/features/tower/` | `kimi-agent/src/tools/tower/mod.rs` | ✅ **100% 原生** | P154：强制校验 Tower Worker 写操作的目标路径，越界逃逸立即否决，杜绝跨分支污染。 |

### 板块 5：上下文管理、压缩与动态注入

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **上下文智能压缩** | `agent-core-v2/src/agent/fullCompaction/`<br>`microCompaction/` | `kimi-agent/src/compaction/mod.rs`<br>`src/compaction/micro.rs` | ✅ **100% 原生** | 基于滑动窗口的上下文裁剪，保留系统提示词、用户首轮意图与最近尾部消息；中段消息结构化提取为第一人称摘要；精准对齐 CJK/多模态/JSON Token 预算。`microCompaction` 已补齐（`compaction/micro.rs`，326 行 + 7 个单测，数字于 2026-09-15 复核）：把超过 `min_content_tokens` 的旧工具结果内容清空，变换是确定性投影，store 保留原文，因此重建出的前缀跨请求稳定。由 `server/engine.rs` 在每轮构建 pipeline 后按 `[experimental].micro_compaction` 应用，并发布 `micro_compaction.apply` 事件。**与 v2 的差异**：v2 额外以「检测到 prompt-cache miss」为触发条件，该信号尚未接入引擎，目前仅由开关决定。 |
| **提醒与节律注入** | `agent-core-v2/src/features/reminder/` | `kimi-agent/src/injection/mod.rs`<br>`src/injection/goal_plan.rs` | ⚠️ **部分对齐** | `<system-reminder>` 包装与识别。内置日期变更注入、工作区 AGENTS.md 动态提醒、Goal 预算耗尽与 Plan-Mode Cadence 节律注入，压缩操作不丢失注入块。**2026-09-15 更正**：v2 的 `permission_mode` 变体（`agent-core-v2/src/agent/permissionMode/injection/permissionModeInjection.ts`，进入/退出 auto 模式的两段提醒）在 fork 中**整体不存在**——`injection/` 无该变体，全仓（含 `apps/`）也搜不到 `permission-mode-auto-enter-reminder.md` 的文案。后果：auto 模式下模型从未被告知"不要调用 AskUserQuestion"（只会在调用后被 `AutoModeAskUserQuestionDeny` 拒绝而浪费一步），「自动批准的 ExitPlanMode 不代表用户同意执行」这一关键约定也从未传达。工单见 §6.1。 |

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
| **REST API 全路由** | `packages/kap-server/src/routes/`（41个文件） | `kimi-agent/src/server/router.rs`<br>`src/server/http.rs`, `fs_routes.rs` | ✅ **100% 原生** | 原生提供 `/api/v1` 全量接口：`/sessions` (CRUD, status, abort, fork)、`/workspaces`、`/skills`、`/models`、`/mcp`、`/plugins`、`/terminals`、`/fs` 等。 |
| **WebSocket 全双工** | `packages/kap-server/src/ws/` | `kimi-agent/src/server/ws.rs`<br>`src/server/hub.rs` | ✅ **100% 原生** | RFC 6455 协议支持，实现打字机推流（stream.delta）、思考流（thinking.delta）、工具进度（tool.progress）、双向 Prompt/Cancel 控制帧与心跳 Ping/Pong（含 40112 鉴权）。 |
| **虚拟终端 PTY** | `packages/kap-server/src/terminal/` | `kimi-agent/src/server/terminal.rs` | ✅ **100% 原生** | 跨平台终端管理，基于 `portable-pty`（wezterm）：每个终端是一个真伪终端，REST 创建/列出/关闭 + WebSocket 二进制双向吞吐，`resize` 经 `MasterPty::resize` 下达 `TIOCSWINSZ`/`ResizePseudoConsole` 给子进程，Ctrl-C、作业控制与 `isatty` 行为与真终端一致。 |
| **静态资产与 SPA** | `packages/kap-server/src/routes/webAssets.ts` | `kimi-agent/src/server/static_files.rs` | ✅ **100% 原生** | 内置静态 Web 资源托管与 SPA 前端回退路由支持。 |

### 板块 8：客户端 SDK 与通讯协议

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **ACP 协议宿主** | `packages/acp-server/` | `kimi-agent/src/acp/mod.rs`<br>`src/acp/types.rs` | ⚠️ **部分对齐** | 原生 Agent Client Protocol (ACP) 规范实现，支持 Stdio 与网络通道，零 Node 依赖。**2026-09-15 审计修正**（证据均为本轮独立抽验）：`stopReason` 用 `format!("{:?}")`（`src/server/engine.rs:1250`，测试断言 `"EndTurn"`，见 `:1770`），发的是 Rust 枚举名而非 ACP 的 `end_turn`/`cancelled`/`refusal`，严格客户端解析失败且被取消的回合不显示 cancelled；`$/cancel_request` 全仓零命中（取消请求得 -32601，回合继续消耗 token，只有 `session/cancel` 通知生效）；`terminal/kill` 仅定义无调用点（`src/acp/channel.rs:209-212`），客户端终端里挂死的命令无法终止；`additionalDirectories` 在 `src/acp` 零命中，编辑器传入的额外根目录被静默丢弃；Bash 反向改道硬编码 `sh -c`/`cmd /C` 且 `cwd=None`（`src/acp/permission.rs:89-105`），命令跑在客户端终端默认目录而非会话 cwd，`env` 与 4MiB 上限丢失；`session/set_model` 返回 -32601、`set_config_option` 只认 mode。反向 RPC 实为 **9** 个（原写 10/11）。工单见 §6.5。 |
| **Stdio JSON-RPC** | `apps/kimi-code/src/cli/rust-engine.ts` | `kimi-agent/src/rpc/types.rs`<br>`src/main.rs` | ✅ **100% 原生** | 提供严格匹配 LSP/JSON-RPC 2.0 规范的 Stdio 双向通讯层，作为无 NAPI 运行环境的保底通道。 |
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
| **Plan / Stale / Hooks**| `features/plan/`, `staleGuard/`, `externalHooks/` | `kimi-agent/src/tools/` 对应原生模块 | ✅ **100% 原生** | 计划模式审批锁、盲写防护、Pre/PostToolUse 钩子执行全面闭环。 |

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
| 重试遥测事件 TurnStepRetrying | 每次重试持久化/派发 `TurnStepRetrying`（stepRetryService.ts:151-163） | 仅在最终结果有 `llm_retries` 计数 | `turn_step.rs` 每次指数退避前结构化派发 `TurnStepRetrying` 事件（精确携带 failed_attempt, next_attempt, max_attempts, delay_ms） |
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

**语义差异（已全部消除）**：

1. ~~沙箱仅覆盖 write/edit 路径级 + 命令执行；TS 的 bash 拦截层是 permission 策略链（与沙箱无关），Rust 的 permission 链是否等价覆盖命令 glob 审批未在本批审计。~~ **已解决**：`permission/mod.rs` 的策略链新增 fork 专属 `DangerousCommandAsk`（#3），对 bash 调用 `kimi_native_tools::permission_engine::dangerous_command::analyze_bash_command`，高风险命令（shutdown/reboot/rm -rf/format/sudo …）在 Yolo/Auto 下也强制 Ask，对齐 native-tools `test_yolo_mode_refuses_dangerous_reboot` 语义。
2. ~~kimi-agent/src/native/event_store/ 的细粒度事件账本未完整接入 standalone server；session/patch.rs（RFC 6902）无全局生产调用点。~~ **已解决**：event_store 经 `hub.set_persister` 对每个事件落账（server/mod.rs:88-104），fold/checkpoint/undo 已接入；session/patch.rs 由 REST state-PATCH/undo-redo（server/mod.rs:3345-3467）、sqlite_store.rs:1130-1153 与 state_store.rs:187-205 生产调用。persister 错误现已结构化记入 warn 日志；standalone 的 TaskRunner 为进程内内存任务提供生命周期事件分发。
3. ~~standalone 服务端面仍有大量 mock/缺失（2026-09-09 审计修正，此前"均已对齐"结论失实）~~ **已完成（2026-09-11）**：Wave 3 服务端契约与 Wave 4 新能力全部落地——transcript L1/L2（`/transcript`、`/ops`、`/user-messages`、`/plan`，从持久化历史重建 + turn 游标分页）、prompt 侧附件 intake（`POST /prompts` 解析 `content[]`、`f_`/`path` → 原生媒体块注入模型）、debug 三方法（association/runtime-binding/workspace-snapshot）按契约整形且未知方法 404、WS 词汇黄金契约 `ws-event-contract.json`（Rust / kimi-web / protocol 三方断言）与 `event.model_catalog.changed` 发射、ACP（`session/new` 的 `cwd`/`mcpServers`、`fs`/`terminal` 反向 RPC 与 Read/Write/Bash 执行改道、`elicitation/create` 表单桥 + `session/request_permission` 回退，客户端反向 RPC 9 个，其中 `terminal/kill` 无调用点）、Workflow 引擎（内嵌 QuickJS，JS 运行时经 `workflow-js` feature 可选，9 内置工作流 + `Workflow` 工具接线）。校验：`cargo test --lib` 2,349 项（2026-09-15 复核，原写 2,107） + `--tests --features cli` 全绿，clean 构建两种 feature 组合均通过。已知边界（非缺口）：kimi-web 标注为 no-op 的 4 个事件、`elicitation/complete`（规格可选）、`session/set_model`（引擎无运行时模型目录）。

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
| #3594 Remote Control 运行时开关 API | kap-server 路由 + `@moonshot-ai/remote-control` manager | Rust server 暴露 remote-control runtime toggle，与 fork 的 CLI 实现对齐 | **仅 REST 表面（2026-09-13 修正）**：`server/mod.rs` 挂载了 `GET/POST /api/v1/remote-control`，但**没有任何运行时实现**（无设备注册、无通道、无心跳）。此前 POST 会把本地状态改成 `state:"on"` 并回一个 `https://code-rc.kimi.com/devices/<随机id>/` URL，客户端据此展示为「已开启」，实际没有任何监听方。现已修正为：GET 回 `enabled:false` + `available:false` + `reason`，POST 返 501（`REMOTE_CONTROL_UNAVAILABLE`），不再伪造状态。真正的 remote-control 运行时（上游 `@moonshot-ai/remote-control` manager 的等价物）**仍是缺失项**，见文末「未闭环项」。 |
| #3630 会话删除与串行清理 | `deleteSession`、`event.session.deleted` 广播、`ISessionManager.onWillDeleteSession` | Rust server 会话删除端点 + 事件广播 | **已完成**：`server/mod.rs` 支持 `POST /api/v1/sessions/:id:delete`，`event.session.deleted` 携带 `workspaceId` |
| #3548 保留媒体附件名 | 媒体引用新增 `name` 字段 | Rust 原生媒体块类型增加 name 并全链路透传 | **已完成**：`ContentBlock`、`ImageUrl` 等全类型透传 `name: Option<String>`，服务端全链路映射 |
| #3652 / #3649 HEIC/HEIF/BMP 图片 | Kimi 模型接受 HEIC/HEIF/BMP（含首轮默认模型门控） | `native/image_compress.rs` + 媒体 mime 白名单 | **已完成**：BMP 编解码支持，`src/tools/read_media.rs` 针对 Kimi 模型放行 BMP/HEIC/HEIF 并放宽至 5MB 预算（路径于 2026-09-15 更正：该文件在 `src/tools/`，不在 `src/native/`） |
| #3537 compaction 恢复锚定最新用户消息 | 自动压缩后恢复正确请求 | `compaction/mod.rs` 恢复锚点 | **已完成**：实现 `compaction_continuation_message`，LLM 前压缩与紧急压缩均注入恢复锚点 |
| #3645 大文件读取可续读 | 可恢复长行读取与重复截断修复 | `native/read.rs` | **已完成**：`Read` 工具增加 `column_offset` 与 `max_chars` 限制，超限提示断点续读参数 |
| #3658 glob 超过 100 条 | 分页续取 | `src/tools/core_tool_defs.rs` + `src/tools/mod.rs` | **已完成**：`Glob` 工具增加 `head_limit` 和 `offset`，支持分页切片与续取提示（`tools/mod.rs:1843,1954-1995`）。2026-09-15 更正：此处原先写作 `native/glob.rs`，那是模式匹配辅助，不是该工具实现 |
| #3654 MCP 结构化结果去重 | 保留不同的结构化结果 | `mcp/*` | **已完成**：`McpToolCallResult` 新增 `structuredContent` 与 `_meta`，在 `<mcp-result-extras>` 保留完整数据 |
| #3624 LLM retry/recovery 从 llm machine 移到 turn state machine | 重试状态机归位 | `turn_loop/retry.rs` 与 turn 状态机 | **已归位（措辞修正）**：`turn_step.rs` / `run_turn.rs` 自主驱动重试循环。原条目只写「已在…自主驱动」而无证据，保留为已归位。 |
| #3502 统一 fs watch 为单一 xstate 服务 | 文件监听统一 | `kimi-agent/src/server/fs_watch.rs` | ✅ **已接线（2026-09-14，轮询实现）**：`watch_fs_add` / `watch_fs_remove` 注册进 `FsWatchManager`（`server/ws.rs` 镜像 + 连接断开时的 drop guard 清理引用），`run_serve` 启动 750ms 轮询任务，mtime 变化/出现/消失都会在会话 lane 上发布 `event.fs.changed`（`EngineEvent::Custom`，`event_type()` 即该字符串）。**实现说明（非隐瞒）**：用 mtime 轮询而非 inotify/ReadDirectoryChanges——crate 无 notify 依赖，延迟=轮询间隔；`fs_watch.rs` 模块头写明，若延迟敏感可换 OS 后端。测试 `server::fs_watch::tests` 覆盖基线/变更/消失/幂等/上限语义。 |
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
   `server/remote_control.rs`（1317 行；2026-09-15 复核，原写 1339）是原生实现：设备注册、到 `code-rc.kimi.com` 的 WebSocket 中继
   （`tokio-tungstenite`）、心跳与有界指数退避重连、反向 HTTP 代理，由 `server/mod.rs` 持有
   `RemoteControlHandle` 并在 `/api/v1/remote-control` 上暴露真实状态（不再是 `enabled:false` 的诚实占位）。
   TS CLI 那条路径（`apps/kimi-code/src/cli/sub/web/remote-control.ts`）仍在，`kimi rc` /
   `kimi web --remote-control` 走它；两条路径现在都能提供服务。

2. ~~#3502 fs watch 语义~~ **已解决（2026-09-14，见 §1 板块对齐矩阵 #3502 行）**。此前本节曾写「原生有
   `fs_watch.rs` 单一通道」——当时该文件**并不存在**、引擎也没有任何监听实现，`watch_fs_*` 只解析 ack 不发射；
   现已补上：`server/fs_watch.rs` 的 `FsWatchManager`（mtime 轮询，`event.fs.changed` 发到会话 lane），
   WS 注册/注销/断开清理全部接线，`run_serve` 启动轮询任务。轮询而非 inotify 的取舍写在模块头。

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

5. **模式互斥（mode mutex）缺失（2026-09-14 域对照新增）**：v2 `agent/modeMutex/modeMutexService.ts`
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

> 复核方式：把 `upstream/main` 的 v2 源码全量抽出到 `.tmp/v2-ref/`（`agent-core-v2` 1,544 /
> `kap-server` 314 / `klient` 94 / `acp-server` 49 文件），把本文件的每一条声明拿回两侧源码核对，
> 而不是接受本文件自己的措辞。结论：**架构与功能面基本对齐，行为语义面存在已证实缺口。**

### 6.0 缺口为什么会静默堆积（已修）

fork 物理删除了四个被替代的包，于是上游改这些包的提交**不冲突、不报错、也没人看见**。
本轮测得：fork 落后 `upstream/main` 29 个提交，其中 **22 个**改了上述包（merge base `6954d2c8bf`）。

已加机械化门禁 `scripts/check-upstream-v2-delta.mjs`（接在 CI `lint` 作业）：列出 merge base
之后所有触及被删除包的提交，要求每一个都在 `scripts/upstream-v2-delta-allowlist.json` 中带有明确
裁定（`ported` / `tracked` / `not-applicable`；`pending` 或未记录即失败）。当前快照：
`ported=2 | tracked=13 | not-applicable=7`。

同时必须记住：`scripts/scan-parity.mjs` 的比对源**全部是 fork 自有声明**
（`packages/protocol/src/rest/*.ts` 注释清单、`ws-event-contract.json`、`tool-name-contract.json`、
`napi-contract.d.ts`、`node-sdk/src/config-local/schema.ts`），它**从不读取 upstream/v2**。
它的绿灯只证明 fork 内部自洽，**不能**当作 v2 对齐的证据。

### 6.1 未闭环工单（按优先级）

1. **`permission_mode` 提醒注入整体缺失（上游 #3728 / v2 `PermissionModeInjection`）**——变体、
   两段文案与状态键在 fork 中全部不存在（引擎与 app 都没有），因此只加
   `KIMI_CODE_PERMISSION_MODE_REMINDER` 开关没有意义：没有可关闭的注入。
   影响：auto 模式下模型从不被告知"不要调用 AskUserQuestion"（只会在调用后被
   `AutoModeAskUserQuestionDeny` 拒绝、白费一步）；"自动批准的 ExitPlanMode 不代表用户同意执行"
   这一约定从未传达，模型可能据自动批准就开始执行计划。
   落地路径（跨层，宜作独立变更）：新增 `src/injection/permission_mode.rs`（两段文案 + 进入/退出
   转移 + 历史基线扫描，仿 `scan_date_baseline` + env 门禁）→ `RunTurnInput.permission_mode`
   （8 处构造点）→ `src/napi_bindings.rs` 的 `JsRunTurnParams` → `packages/kimi-agent/session-handle.ts`
   → `apps/kimi-code` 传入当前模式；两侧都要补测试。
2. **#3734 流式 attempt 状态未在重试时失效**：`turn_loop/retry.rs`（279 行 / 4 个 pub 项）没有
   attempt-state 失效逻辑，`context_tokens.invalidate()` 属 token 记账而非流式增量。先确认 Rust
   是否存在"被弃用 attempt 的增量泄漏到重试后消息"的路径，再决定是否移植。
3. **#3694 存储失败重建索引 / #3697 steer 打断后台等待 / #3688 MCP 附件原件保留 /
   #3720、#3717 任务通知时序 / #3648 tower 可靠性 / #3606 模型目录运行时 / #3681 `[models]` 告警**：
   已在 allowlist 记为 `tracked`，但尚未逐条与 Rust 实现比对，需要单独一轮 triage。
4. **#3532 v3 扁平实体消息协议（WS + history API）——已决定全量移植（2026-09-15）**：上游用
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
   CI 跳过该段）→ P1 历史 → 扁平实体投影（turn/step/user/assistant/thinking/tool_call 与状态域的
   todo/task 均已完成；`agent_state` 与 `interaction` 无历史源、`session_state` 只有部分来源，
   见下）→ P2 按 turn 分页的 history 路由**已完成**（`GET /api/v1/sessions/{id}/history`：turn
   边界整页、默认 50/上限 200、`before_turn`/`after_step` 互斥、错误码 40001/40401；该路由**始终**
   回信封——上游如此，而 v1 客户端根本不会调它——但错误带真实 HTTP 状态，上游则恒回 200 只靠 `code`
   表达失败。`in_flight` 暂不返回：实时侧还没按同一规则生成 step 字符串，给出错误的位置会让客户端把
   后续增量接到错的 step 上）→
   P3 与 v1 并存的 `/api/v3/ws` → P4 客户端（kimi-inspect、kimi-web、`apps/kimi-code` 的
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
5. **ACP 宿主的部分对齐项（板块 8，已就地标注）**：`stopReason` 非 ACP 枚举（高）、
   `$/cancel_request` 缺失（中高）、`terminal/kill` 死代码（中）、`additionalDirectories` 被静默丢弃
   （中）、Bash 反向改道 `cwd=None` + 硬编码 shell（高）、`session/set_model` 缺失（中）、
   ACP `mcpServers` 写进程级 manager 与 v2 per-session ephemeral 语义相反（中）。

### 6.2 本轮已修复（含证据）

| 上游 | 修复 | 证据 |
|---|---|---|
| #3714 `rm -rf` 仅 `/tmp`、`/temp` 免审 | `RM_SAFE_TEMP_ROOTS` + `is_safe_temp_rm_operand` + `rm` 操作数收集（`--` 之后全为操作数），并把上游 `literalText` 的 `UNSAFE_OPERAND` 字面量判据折叠进操作数检查 | `src/native/permission_engine/dangerous_command.rs`；新增 `test_rm_rf_temp_paths_are_exempt`（7 个免审用例）与 `test_rm_rf_outside_temp_paths_stay_dangerous`（9 个危险用例） |
| #3657 移除 wall-clock 时间预算上限 | 删除 `MAX_REASONABLE_TIME_BUDGET_MS`，只校验 `>= 1s` 且有限；工具描述逐字对齐上游 `set-goal-budget.md:15-17` | `src/goal/mod.rs`、`src/tools/goal_tools.rs`；新增 `test_set_budget_accepts_durations_above_the_former_24h_ceiling`，`storage/state_store.rs` 改为断言亚秒预算被拒 |

验证：`cargo test --features cli --lib` → **2349 passed / 0 failed / 1 ignored**（2026-09-15）。

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
