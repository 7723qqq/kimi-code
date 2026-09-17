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
| **并发工具调度** | `agent-core-v2/src/agent/toolExecutor/toolExecutor.ts` | `kimi-agent/src/turn_loop/tool_scheduler.rs` | ✅ **100% 原生** | 基于 `infer_tool_accesses` 静态推断资源冲突，构建并发批次。写写冲突、写读冲突严格串行化，只读工具并发放行；Bash 推断为全资源独占（`all_access()`，与 v2 未声明兜底一致），`write_tree_access("/")` 只用于 tower merge/teardown。 |
| **故障退避与重试** | `agent-core-v2/src/_base/utils/retry.ts` | `kimi-agent/src/turn_loop/retry.rs` | ✅ **100% 原生** | 指数退避，基数 500ms、上限 32,000ms，抖动为**单侧** `+[0, 25%]`（对齐 v2 `retryBackoffDelay`：`base + Math.random() * 0.25 * base`；v2 无下限）。错误分类对齐 v2 `isRetryableGenerateError`：可重试集 {408, 409, 429, 500..=599}（Rust 额外含 425），429 配额/欠费文案豁免（kimi-errors.ts 判据）；重试次数可经 `RunTurnInput.max_attempts` 配置，默认 10 对齐 v2 `DEFAULT_MAX_RETRY_ATTEMPTS`。 |
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
| **REST API 全路由** | `packages/kap-server/src/routes/`（41个文件） | `kimi-agent/src/server/router.rs`<br>`src/server/http.rs`, `fs_routes.rs` | ✅ **100% 原生** | 原生提供 `/api/v1` 全量接口：`/sessions` (CRUD, status, abort, fork)、`/workspaces`、`/skills`、`/models`、`/mcp`、`/plugins`、`/terminals`、`/fs` 等。 |
| **WebSocket 全双工** | `packages/kap-server/src/ws/` | `kimi-agent/src/server/ws.rs`<br>`src/server/hub.rs` | ✅ **100% 原生** | RFC 6455 协议支持，实现打字机推流（stream.delta）、思考流（thinking.delta）、工具进度（tool.progress）、双向 Prompt/Cancel 控制帧与心跳 Ping/Pong（含 40112 鉴权）。 |
| **虚拟终端 PTY** | `packages/kap-server/src/terminal/` | `kimi-agent/src/server/terminal.rs` | ✅ **100% 原生** | 跨平台终端管理，基于 `portable-pty`（wezterm）：每个终端是一个真伪终端，REST 创建/列出/关闭 + WebSocket 二进制双向吞吐，`resize` 经 `MasterPty::resize` 下达 `TIOCSWINSZ`/`ResizePseudoConsole` 给子进程，Ctrl-C、作业控制与 `isatty` 行为与真终端一致。 |
| **静态资产与 SPA** | `packages/kap-server/src/routes/webAssets.ts` | `kimi-agent/src/server/static_files.rs` | ✅ **100% 原生** | 内置静态 Web 资源托管与 SPA 前端回退路由支持。 |

### 板块 8：客户端 SDK 与通讯协议

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **ACP 协议宿主** | `packages/acp-server/` | `kimi-agent/src/acp/mod.rs`<br>`src/acp/types.rs` | ⚠️ **部分对齐** | 原生 Agent Client Protocol (ACP) 规范实现，支持 Stdio 与网络通道，零 Node 依赖。**2026-09-15 审计修正**（证据均为本轮独立抽验）：`stopReason` 用 `format!("{:?}")`（`src/server/engine.rs:1250`，测试断言 `"EndTurn"`，见 `:1770`），发的是 Rust 枚举名而非 ACP 的 `end_turn`/`cancelled`/`refusal`，严格客户端解析失败且被取消的回合不显示 cancelled；`$/cancel_request` 全仓零命中（取消请求得 -32601，回合继续消耗 token，只有 `session/cancel` 通知生效）；`terminal/kill` 仅定义无调用点（`src/acp/channel.rs:209-212`），客户端终端里挂死的命令无法终止；`additionalDirectories` 在 `src/acp` 零命中，编辑器传入的额外根目录被静默丢弃；Bash 反向改道硬编码 `sh -c`/`cmd /C` 且 `cwd=None`（`src/acp/permission.rs:89-105`），命令跑在客户端终端默认目录而非会话 cwd，`env` 与 4MiB 上限丢失；`session/set_model` 返回 -32601、`set_config_option` 只认 mode。反向 RPC 实为 **9** 个（原写 10/11）。工单见 §6.5。 |
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
裁定（`ported` / `tracked` / `not-applicable`；`pending` 或未记录即失败）。当前快照（2026-09-17
三次复核，merge base 不变、上游推进到 `25dd4ce973`，即 `@moonshot-ai/kimi-code@2.0.0` 之后）：
`ported=21 | tracked=11 | not-applicable=21`（53 条）。

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
3. **#3694 存储失败重建索引 / #3648 tower 可靠性**：
   已在 allowlist 记为 `tracked`，但尚未逐条与 Rust 实现比对，需要单独一轮 triage。
   （原列的 #3681 `[models]` 告警已落地，见第 14 条；#3720 / #3717 已拆出，见第 15 条；
   #3606 模型目录运行时已落地，见第 16 条；**#3697 与 #3688 已从本条移出并落地**，见 §6.2。）
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
   本端点的留白（上游有、本 fork 暂无生产者）：全局 lane（`session`/`workspace`/`config`/`plugin`/
   `model_catalog`/`capability`）未广播、实时 turn 的 `usage` 为空、`config.warning` 无来源、慢消费者尚未用
   `WS_SLOW_CONSUMER 42903` 回告；`in_flight` 仍未接入历史路由）→ P4 客户端（kimi-inspect、kimi-web、`apps/kimi-code` 的
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
9. **#3667 动态工具与 MCP 延迟披露**：三部分全缺——官方模型的 `dynamically_loaded_tools`
   能力（`server/provider_refresh.rs:83-141`）、每服务器 `deferred` 字段
   （`config/mod.rs:155-198`）、`select_tools` 的广告位（可执行但从未进入
   `tools/tool_policy.rs:128-165` 的工具表；`tools/select_tools.rs:19-26` 明确写着延迟披露
   刻意未实现）。
10. **#3747 提示队列折叠的两个行为差**：(a) ~~中止已结算提示 Rust 返回 40903~~ **已解决
    （2026-09-15 后续变更）**：`:abort` 路由对不在队列中的提示词改回 40402 `PROMPT_NOT_FOUND`
    （HTTP 404，不再带 `{ aborted: false }`，`server/mod.rs:5497-5505`），Rust 错误码表与
    `packages/protocol` 同步删除 40903 与 `prompt.already_completed`，kimi-web 客户端去掉
    `allowCodes: [40903]`——40402 走它既有的 `PROMPT_NOT_FOUND_CODE` 分支，用户可见行为不变。
    (b) 提示图片压缩说明在 Rust 媒体入口完全缺失（`server/mod.rs:1011-1120`），属既有缺口，
    本轮未动。
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
15. **#3720 移除前抑制任务通知 / #3717 拆除后迟到结算静默**（2026-09-15 后续变更）：
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
    ③ **上传鉴权失败降级而非抛出**。v2 `isMediaUploadAuthError` 直接 throw；fork 降级为路径标签，
    真正的鉴权错误由随后的 chat 请求报出（用户仍能看到，但失败点不同）。
    ④ **预算只覆盖 image/video/audio 的内联形态**，与 v2 的 image/video 一致（audio 在 v2 不计，
    fork 把 audio 的 data URL 也计入了——这是 fork 多出的一项，不是缺失）。

18. ~~**#3838 取消操作把 AbortError 抛成进程崩溃（live 包，未移植）**~~ **已解决（2026-09-17）**。
    `packages/telemetry/src/crash.ts` 的 sole-listener 分支改为 `if (soleListener && !isAbortError(reason))`，
    并补上上游那段 AbortError 注释；该文件现与 `upstream/main` **逐字一致**（`git diff --no-index` 空）。
    另一半（agent-core-v2 的 xstate2 abort 管线）无 Rust 对应物，不移植。
    验证：`telemetry.test.ts` 新增 `does not rethrow an aborted-operation rejection when it is the only listener`
    （清空 vitest 自己的 listener 让 crash handler 成为唯一 listener，断言 AbortError 既不上报也不 rethrow，
    返回 `NOT_CAUGHT` 哨兵）；allowlist `f4e5822164` 由 `tracked` 改判 `ported`。

19. **#3764 prompt / skill-activation 的 client metadata 与 display_text（未移植）**：上游在 prompt 与
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

21. **#3832 被 steer 的用户 slash skill activation 未记录（TS 侧 + 引擎侧）**：上游
    `packages/transcript/src/contract/{origin,schema}.ts` 增加 `skill_activation` origin 变体
    （trigger user-slash + skillName + skillArgs），fork 仍是只有 `user` 变体
    （`rg "skill_activation" packages/transcript/src/contract/` 为空，该包停在合并时的上游 0.0.2）。
    当前仓内无任何包 import `@moonshot-ai/transcript`，因此尚不可见；Rust 引擎投影自己的 origin
    （`server/transcript/model.rs:81` `UserOriginKind`、`:308` `TranscriptUserOrigin`），
    被 steer 的 slash activation 也要进到那里。**验收**：TS 契约随上游合并落地，且引擎 origin 投影
    覆盖 steer 路径的 skill activation（allowlist: `1c7e996aa8`）。

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
   发出**；本引擎（`events/types.rs`）只发 `spawned` / `started` / `suspended` / `completed` /
   `failed` / `message`。故 `notify.ts`、`session-event-handler.ts`、
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
- **#3843「skill scopes（`tui` / `web` 白名单）+ custom-theme 标记为 tui-only」尚未落地**：
  上游把该字段穿过 `SkillSummary`、klient RPC 与 kap-server REST；本引擎的技能目录**不产出
  `scopes`**（全仓 `rg '"scopes"'` 无命中）。已先在 `packages/node-sdk/src/types.ts` 的
  `SkillSummary` 上补可选字段（引擎未发，取值为 `undefined` 时语义即「所有界面可见」，
  与上游默认一致），TUI 侧的过滤逻辑已经就位；真正要做的是让引擎的技能目录产出该字段。

17. **#3843 skill scopes 未落地（引擎侧）**：上游 `da31c472a2` 让内置技能可声明
    `scopes` 白名单（`tui` | `web`），无 `scopes` 即处处可见；值穿过 `SkillSummary`、
    klient RPC 契约与 kap-server REST wire，TUI slash 命令据此过滤，HTTP 客户端（code-app）
    据此丢掉不属于自己 UI 模式的技能（如 `/custom-theme` 不再泄进 web）。**本 fork 的现状**：
    `packages/node-sdk/src/types.ts` 的 `SkillSummary` 已补可选 `scopes` 字段（合并时补，
    引擎尚未产出，取 `undefined` 即「处处可见」，与上游默认语义一致），
    `apps/kimi-code/src/tui/commands/skills.ts` 的 `isVisibleOnTui()` 过滤也已就位；
    缺的是**引擎技能目录产出该字段**（`packages/kimi-agent` 的技能目录 RPC 响应，
    以及内置技能的 `scopes` 声明来源）。**验收**：引擎的技能列表响应带 `scopes`
    （或明确省略），且带 `scopes: ["tui"]` 的技能不出现在 web/ACP 客户端。

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
