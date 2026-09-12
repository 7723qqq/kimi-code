# kimi-agent (Rust 原生引擎) 替代 v2 战略路线图与全量子系统技术对齐矩阵

> **战略总目标**：**彻底删除 `packages/agent-core-v2`（下称 v2）**。
> 
> 本路线图唯一的终态判定标准是：**v2 从 Monorepo 中物理消失，且 `apps/kimi-code`、`packages/kap-server` 与 `packages/klient` 完全由 Rust 原生引擎驱动**。
> 功能等效只是迁移期的过渡验收手段，不是终点。
> 
> 历史演进档案（P0–P156 详细批次记录、测试断言、相对性能基准与工程决策）已完整归档至：[ROADMAP-history.md](./ROADMAP-history.md)。

---

## 1. 全架构 10 大子系统技术深度对齐矩阵（TS 源码 vs Rust 引擎）

本矩阵从零系统性复盘 GitHub 上 TypeScript 核心源码（覆盖 `agent-core-v2`（1,018 个文件）、`kap-server`（164 个文件）、`klient`（50 个文件）、`kosong`（41 个文件）、`transcript`（25 个文件）、`minidb`（58 个文件）等全仓 1,400+ 个 TS 源文件），对标 Rust 引擎（`packages/kimi-agent`，含 `src/native/` 原生工具层）的实现深度：

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

### 板块 3：原生基础工具链与沙箱执行网关

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **文件读写与修改** | `agent-core-v2/src/agent/tools/os/`<br>`read/`, `write/`, `edit/` | `kimi-agent/src/native/read.rs`<br>`write.rs`, `edit.rs` | ✅ **100% 原生** | Read：行范围（`line_offset`/`n_lines`，上限1000行）、截断（2000字符）、编码侦测与媒体回退；Write：支持 append/overwrite 与原子写入；Edit：严格唯一匹配断言与 replace_all 模式。 |
| **文件搜索与模式匹配**| `agent-core-v2/src/agent/tools/os/`<br>`grep/`, `glob/` | `kimi-agent/src/native/grep.rs`<br>`glob.rs` | ✅ **100% 原生** | Grep：内置 ripgrep 核心正则引擎，开启 `--hidden` 且完整移植 `isSensitiveFile` 敏感文件过滤与脱敏提示；Glob：基于 `ignore`/`globset` 遵循 `.gitignore`，目录折叠。 |
| **命令执行与环境** | `agent-core-v2/src/agent/tools/os/bash/`<br>`packages/kaos/` | `kimi-agent/src/native/bash.rs`<br>`kimi-agent/src/tools/kaos.rs` | ✅ **100% 原生** | 原生执行平台 Bash（Windows 优先定位 MSYS2/Git Bash，拒绝 cmd），支持超时强制 Kill（默认 60s/上限 300s）、256KB 输出截断、非零退出码精确传播、实时输出流向 `tool.progress` 广播。 |
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
| **上下文智能压缩** | `agent-core-v2/src/agent/fullCompaction/`<br>`microCompaction/` | `kimi-agent/src/compaction/mod.rs` | ✅ **100% 原生** | 基于滑动窗口的上下文裁剪，保留系统提示词、用户首轮意图与最近尾部消息；中段消息结构化提取为第一人称摘要；精准对齐 CJK/多模态/JSON Token 预算。 |
| **提醒与节律注入** | `agent-core-v2/src/features/reminder/` | `kimi-agent/src/injection/mod.rs`<br>`src/injection/goal_plan.rs` | ✅ **100% 原生** | `<system-reminder>` 包装与识别。内置日期变更注入、工作区 AGENTS.md 动态提醒、Goal 预算耗尽与 Plan-Mode Cadence 节律注入，压缩操作不丢失注入块。 |

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
| **虚拟终端 PTY** | `packages/kap-server/src/terminal/` | `kimi-agent/src/server/terminal.rs` | ✅ **100% 原生** | 跨平台终端管理，支持 REST 创建/调整窗口尺寸（resize）与 WebSocket 二进制双向终端数据吞吐。 |
| **静态资产与 SPA** | `packages/kap-server/src/routes/webAssets.ts` | `kimi-agent/src/server/static_files.rs` | ✅ **100% 原生** | 内置静态 Web 资源托管与 SPA 前端回退路由支持。 |

### 板块 8：客户端 SDK 与通讯协议

| 子模块 / 职责 | TypeScript 源码（GitHub 原型） | Rust 引擎实现 | 对齐状态 | 架构深度分析与技术细节 |
|---|---|---|:---:|---|
| **ACP 协议宿主** | `packages/acp-server/` | `kimi-agent/src/acp/mod.rs`<br>`src/acp/types.rs` | ✅ **100% 原生** | 原生 Agent Client Protocol (ACP) 规范实现，支持 Stdio 与网络通道，零 Node 依赖。 |
| **Stdio JSON-RPC** | `apps/kimi-code/src/cli/rust-engine.ts` | `kimi-agent/src/rpc/types.rs`<br>`src/main.rs` | ✅ **100% 原生** | 提供严格匹配 LSP/JSON-RPC 2.0 规范的 Stdio 双向通讯层，作为无 NAPI 运行环境的保底通道。 |
| **客户端 SDK 门面** | `packages/klient/src/` | `kimi-agent/src/rpc/types.rs` | 🟡 **依赖 v2** | TS 侧 `klient` 内部包含 122 处对 v2 类型的引用，需改造为直接连接 Rust REST/WebSocket 或内存通道。 |

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

## 2.5 引擎语义对齐批次（P156.5 / P157）与已知差异（已全部消除）

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
| 文件变动回滚与持久化撤销清理 | undo 时级联清理文件历史并在请求时还原工作区受影响文件 | undo 仅删除 messages 与 turns，无文件回滚 | `sqlite_store.rs` 实现了 `revert_turn_file_changes` 并级联删除 `session_file_history`，服务端的 undo 端点接入工作区文件物理恢复 |

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
2. ~~kimi-agent/src/native/event_store/ 的细粒度事件账本未完整接入 standalone server；session/patch.rs（RFC 6902）无全局生产调用点。~~ **已解决**：event_store 经 `hub.set_persister` 对每个事件落账（server/mod.rs:88-104），fold/checkpoint/undo 已接入；session/patch.rs 由 REST state-PATCH/undo-redo（server/mod.rs:3345-3467）、sqlite_store.rs:1130-1153 与 state_store.rs:187-205 生产调用。遗留细节：persister 丢弃 `append_wire_event` 错误（server/mod.rs:103）、standalone 的 TaskRunner 无持久化（server/mod.rs:86）。
3. ~~standalone 服务端面仍有大量 mock/缺失（2026-09-09 审计修正，此前"均已对齐"结论失实）~~ **已完成（2026-09-11）**：Wave 3 服务端契约与 Wave 4 新能力全部落地——transcript L1/L2（`/transcript`、`/ops`、`/user-messages`、`/plan`，从持久化历史重建 + turn 游标分页）、prompt 侧附件 intake（`POST /prompts` 解析 `content[]`、`f_`/`path` → 原生媒体块注入模型）、debug 三方法（association/runtime-binding/workspace-snapshot）按契约整形且未知方法 404、WS 词汇黄金契约 `ws-event-contract.json`（Rust / kimi-web / protocol 三方断言）与 `event.model_catalog.changed` 发射、ACP（`session/new` 的 `cwd`/`mcpServers`、`fs`/`terminal` 反向 RPC 与 Read/Write/Bash 执行改道、`elicitation/create` 表单桥 + `session/request_permission` 回退，客户端反向 RPC 10/11）、Workflow 引擎（内嵌 QuickJS，JS 运行时经 `workflow-js` feature 可选，9 内置工作流 + `Workflow` 工具接线）。校验：`cargo test --lib` 2,107 项 + `--tests --features cli` 全绿，clean 构建两种 feature 组合均通过。已知边界（非缺口）：kimi-web 标注为 no-op 的 4 个事件、`elicitation/complete`（规格可选）、`session/set_model`（引擎无运行时模型目录）。

> **工作区状态（2026-09-06 更新）**：P157–P161 已落地——`agent-core-v2`/`klient`/`acp-server` 已物理删除，
> `kimi-native-tools` 已并入 `packages/kimi-agent/src/native/`（单 crate、单 `.node`、单 npm 包），
> TS 侧消费方（kap-server compat 层、node-sdk、kosong、i18n、apps/kimi-code）全部改指原生引擎，
> `bun run typecheck` / `lint` 全绿。终态门禁 `scripts/check-no-legacy-engine.mjs` 已接入 CI lint job。

---

## 3. v2 消费方 370 处静态引用点逐包拆解

要达成终极目标 P33（彻底物理删除 `agent-core-v2`），必须清空以下 5 个消费方的 370 处依赖：

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

## 4. 决战路线图：从「双轨并存」到「v2 彻底删除」（P157–P162）

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

### P158 — `kap-server` 切流至 Rust 原生服务层
- `kap-server` 改造为轻量代理直接转发至 `kimi-agent` 启动的原生 HTTP/WS 服务端口，或者直接使用编译出的原生二进制作为后台守护进程；
- 一次性剥离 `kap-server` 中对 `agent-core-v2` 的 175 处服务依赖。

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
