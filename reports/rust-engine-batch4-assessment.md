# 第四批可直移评估（宿主独有能力工具）

> 状态：评估完成（只读代码，未改任何 src/ 文件）
> 范围：`reports/rust-engine-state-tools-survey.md` 第四批 11 个工具族（session_query / Memory / Knowledge / lsp / run_code / Tower 11 件 / Team / AgentSwarm / Workflow / Agent / SelectTools）
> 目标：评估哪些可以低成本直移（部分逻辑或完整），给出工具清单表、建议与落码顺序
> 关联：第 4 批三地基（反向交互协议 / 状态层归属 / 子代理递归）已落码完成（ROADMAP 2026-09-01）；第 7 批 16 个原生工具已直移；P28 `spawn_and_run` 已就绪

## 1. 结论摘要

- **1 个工具（Knowledge）实际是「存储已在 Rust」**：v2 的 `AgentKnowledgeService` 直接调用 `@moonshot-ai/kimi-native-tools` 的 `knowledge_open/add/search/remove/confirm/stats/import`（`kimi-native-tools/src/knowledge.rs`，820 行，SQLite + FTS5）。**调研报告「nativeKnowledge 已随 kimi-native-tools 退场」的说法是错的**——addon 仍导出 7 个 `#[napi]` 函数且 v2 仍在调用。直移障碍只剩 Cargo 依赖（kimi-agent 当前无 rusqlite/once_cell）。
- **2 个编排算法可整体直移**：Team 的 coordinator 逻辑（`DiscussionContext` + `TeamCoordinator` + `StructuredDebateCoordinator` ≈ 1100 行纯编排）与 AgentSwarm 的 `AgentRunBatch`（646 行纯批调度算法，零宿主依赖，只依赖 launcher 接口）。前置是 `SubagentManager` 的 persistent 化（多轮 run_turn + usage 聚合），P28 `spawn_and_run` 已提供单轮基础。
- **3 组纯函数可先行直移**：session_query 的 filters/search/cursor/lineage 算法、Memory 的 memoryPaths 纯函数、Agent 工具的格式化/校验纯函数。均无依赖、可完整单测。
- **4 个长期留 host**：lsp（完整 LSP 客户端是独立工程）、run_code（JS 运行时，Rust 无法执行 JS）、Workflow（vm sandbox + JS DSL）、Tower 11 件（`.tower/` 协议是 v1 逐字移植，AGENTS.md 明令不动）。
- **1 个无直移价值**：SelectTools（薄壳，依赖宿主工具注册表 + 模型能力门控，Rust 引擎工具集编译期固定）。

## 2. 工具清单表

| 工具 | 可直移部分 | 留 host 部分 | 成本 | 前置依赖 |
|---|---|---|---|---|
| **Knowledge** | 整个存储层（`kimi-native-tools/src/knowledge.rs`：schema/FTS5 搜索/markdown import/stats，去 napi 化即可）+ 工具壳（action 分发 + 渲染，`knowledge-tool.ts` 116 行） | DB 路径解析（`.kimi-code/knowledge.db` → fallback `~/.kimi-code/knowledge.db`，纯路径约定可一并直移）；main-agent-only 门控 | **中**（复制模块 + 去 napi 化 + 工具壳；唯一障碍是 Cargo 依赖） | **Cargo 新增 `rusqlite`（bundled）+ `once_cell`**（当前 kimi-agent 无此依赖，需决策） |
| **Team** | `context.ts`（DiscussionContext：转录/立场/交叉引用检测/渲染，228 行纯数据）+ `coordinator.ts`（TeamCoordinator 276 行）+ `debate-coordinator.ts`（StructuredDebateCoordinator 584 行）+ `teamTool.ts` 的 formatDiscussionResult/formatDebateResult 渲染 | `IPersistentSubagentService`（persistent 子代理生命周期）、`IAgentSwarmService`（swarm mode 开关）、`display: agent_call` | **中**（coordinator 逻辑直移 ≈1100 行；需先扩展 SubagentManager） | **SubagentManager persistent 化**：`spawnPersistent` 语义（常驻实例多轮 `run_turn`，非一次性 spawn_and_run）+ usage 聚合（TokenUsage 已有）+ 取消传播 |
| **AgentSwarm** | `agentRunBatch.ts`（AgentRunBatch 646 行纯算法：并发限制/rate-limit 退避/容量收缩恢复/超时/取消，只依赖 `AgentRunBatchLauncher` 接口）+ `resolveSwarmMaxConcurrency` + 工具壳渲染 | launcher 实现（spawn/resume/retry 走 `ISessionSubagentService`）、swarm mode 状态、`display: agent_call` | **中**（AgentRunBatch 直移 ≈600 行 + 单测；launcher 用 SubagentManager 实现） | 同 Team：SubagentManager persistent 化（resume/retry 语义） |
| **session_query** | `filters.ts`（filterSessionResults/materializeSessionResultFilters）、`search.ts`（filterSessionEvents/searchEventDocuments 排序分页）、`cursor.ts`（offset 游标）、`lineage.ts`（traceLineage）、`toolPresentation.ts`（86 行渲染）、`toolInput.ts`（240 行校验） | 数据源：`ISessionIndex`（minidb 读模型）+ `IAppendLogStore` + `IFileSystemStorageService`（事件文档存储）、`IWorkspaceLifecycleService`（live 判定） | **中**（算法直移 ≈600 行可完整单测；但引擎无会话存储，工具落地需宿主数据桥） | 无（纯函数可先行）；工具落地需「宿主数据桥」（host RPC 拉事件文档，或 state_read 扩展） |
| **Memory** | `memoryPaths.ts`（projectIdFromCwd/detectType/extractTitle/buildSnippet/parseMemoryPath/sanitizeFileName/buildRelPath，114 行纯函数）+ `memoryTool.ts` 的 search/read/list 渲染 | `IMemoryStore`（minidb 全文索引）、`IBootstrapService`（homeDir）、session context（cwd/sessionId） | **中**（文件布局是纯路径约定可直移；搜索可降级为 buildSnippet 式子串匹配；完整 FTS 需 SQLite） | 无硬前置（降级路径零依赖）；完整搜索质量依赖 rusqlite（同 Knowledge 的依赖决策） |
| **Agent** | 参数校验（resume+type 互斥、fork 门控、background 门控）、输出格式化（formatBackgroundAgentResult/formatForegroundAgentSuccess/formatForegroundAgentFailure ≈60 行）、buildProfileDescriptions | profile catalog（agent 类型列表来自宿主配置）、tool policy 门控、background 任务注册（`IAgentTaskService`）、resume 语义（agent 实例持久化在宿主 session 元数据）、`display: agent_call` | **中**（格式化/校验直移容易；完整工具需 Rust 侧 profile 目录 + 任务模型 + resume） | background 任务模型（进行中，task 工具已走 state bridge 模式）+ profile 目录 |
| **lsp** | `lspTool.ts` 的 renderResult/renderLocations/renderHover/truncate（≈50 行）、`translate.ts` 的 uriToPath、`framing.ts`（Content-Length 帧协议） | `ILspService`（LspInstance/LspConnection/LspStdioProvider：语言服务器子进程生命周期）、`ISessionProcessRunner`、`[lsp]` 配置节 | **高**（完整 LSP 客户端是独立工程；仅渲染层直移价值小） | 无（渲染层可随时移）；完整工具需 LSP 客户端工程 |
| **run_code** | 输出格式化（≈20 行） | `node:worker_threads` 执行 JS（codeWorkerSource.ts 是 JS 源码）、sandbox policy | **高**（Rust 无 JS 运行时；语义差异不可弥合） | 无（无实质可移） |
| **Workflow** | `formatStatus`（≈20 行渲染） | `IWorkflowService`（注册表 + 运行编排）、vm sandbox（脚本是 JS DSL）、子代理 spawn | **高**（脚本执行引擎是 vm + JS，Rust 无对应物） | 无（无实质可移） |
| **Tower 11 件** | 各工具壳的输入校验 + 输出渲染（status/plan 表格等，每件 13-93 行）；spawnTool 的 buildPrompt 文本模板（依赖 store 路径） | `protocol/store.ts`（984 行 `.tower/` 文件协议，v1 逐字移植）、`protocol/git.ts`（git CLI）、TowerSpawn 的子代理生命周期 + rate limit + model catalog | **高**（协议是 v1 逐字移植，AGENTS.md 明令「不建议动」；ROADMAP 已定保持 host 侧） | 无（长期留 host） |
| **SelectTools** | 无独立逻辑（薄壳，输出拼装 ≈10 行） | `IAgentToolSelectService`（工具加载/卸载状态 + 模型能力门控） | **低**（薄壳）但**价值低**（Rust 引擎工具集编译期固定，无运行时注册表） | 无（长期留 host） |

## 3. 逐工具评估详情

### 3.1 Knowledge — 第四批最大发现：存储层已在 Rust

v2 实现链：`knowledge-tool.ts`（工具壳）→ `AgentKnowledgeService`（`agent/knowledge/knowledgeService.ts`）→ `require('@moonshot-ai/kimi-native-tools')` 的 7 个 `#[napi]` 函数 → `kimi-native-tools/src/knowledge.rs`（820 行）。

`knowledge.rs` 是自包含模块：全局 `Mutex<Option<Connection>>` + SQLite schema（entries 表 + FTS5 虚拟表 + 触发器 + 索引）+ 7 个导出函数（open/add/search/remove/confirm/stats/import）。除 `#[napi]` 属性与 `napi::bindgen_prelude` 外无其他依赖（rusqlite + once_cell + serde）。

**直移路径**：把 `knowledge.rs` 复制进 kimi-agent（如 `src/knowledge/`），去掉 `#[napi]` 改为普通 `pub fn`（napi 的 `Result<()>`/`Result<String>` 错误映射改为 `Result<T, String>` 即可），工具壳按 `knowledge-tool.ts` 的 action 分发直移。DB 路径解析（cwd `.kimi-code/knowledge.db` → fallback homeDir）是纯路径约定，一并直移。

**唯一障碍**：kimi-agent 的 Cargo.toml 无 `rusqlite`/`once_cell`（kimi-native-tools 有：`rusqlite 0.32 bundled` + `once_cell 1`）。按「不新增依赖」约束需先决策；若批准，这是第四批里**性价比最高**的直移（存储逻辑零重写，只做模块搬运 + 工具壳）。

### 3.2 Team — coordinator 逻辑整体可直移

- `context.ts`（228 行）：纯数据 + 渲染，零依赖（文件头自述 "No dependency on agent, loop, or any other core module"）。`DiscussionContext` 的转录/立场记录/交叉引用正则检测/`getTranscript`/`getDebateTranscript` 渲染全部可直移。
- `coordinator.ts`（276 行）：`TeamCoordinator` 只依赖 `PersistentSubagentHost` 接口（spawnPersistent/runDiscussionTurn/getPersistentUsage/destroyPersistent）+ AbortSignal。编排逻辑（轮次循环、turn prompt 构建、summary 生成、usage 聚合、失败/取消兜底）是纯算法。
- `debate-coordinator.ts`（584 行）：`StructuredDebateCoordinator` 同构（四阶段：opening/free_debate/closing/consensus + 可选投票），同样只依赖 host 接口。
- `teamTool.ts`：`formatDiscussionResult`/`formatDebateResult` 渲染纯函数可直移；`display: agent_call` 可降级为纯文本。

**Rust 侧缺口**：`SubagentManager`（`subagent/manager.rs`）的 `spawn_and_run` 是一次性后台 `run_turn`（P28 批 3），而 v2 的 `spawnPersistent` 是**常驻实例**（可多轮 `runDiscussionTurn`，最后 destroy）。需扩展：persistent 实例（保留 messages 历史 + 可多次 run_turn）+ usage 聚合（`TokenUsage` 类型已有）+ 取消（AtomicBool 已有）。这是 Team 与 AgentSwarm 的共同前置。

### 3.3 AgentSwarm — AgentRunBatch 是纯算法

`agentRunBatch.ts`（646 行）是**零宿主依赖**的批调度器：只依赖 `AgentRunBatchLauncher` 接口（spawn/resume/retry/suspended）+ AbortSignal + retry 库（指数退避，Rust 侧 `tokio::time` 手写即可）。内含：初始 5 并发 + 700ms 间隔、rate-limit 模式（容量收缩 2s / 恢复 3min、全局重试间隔、pending 重排）、超时、用户取消全量 aborted 结果。`SessionSwarmService`（241 行）才是宿主胶水（spawn/resume/observe 走子代理服务 + 事件分发）。

**直移路径**：`AgentRunBatch` → Rust（如 `src/swarm/agent_run_batch.rs`），launcher 用 trait 抽象；`resolveSwarmMaxConcurrency`（env 解析）一并移。单测可完全脱离宿主（mock launcher）。

### 3.4 session_query — 算法可移，数据源是硬缺口

纯逻辑（filters/search/cursor/lineage ≈ 500 行 + toolPresentation 86 行 + toolInput 240 行）全部无宿主依赖，可直移 + 单测。但 `SessionQueryService` 的数据源是宿主独有：`ISessionIndex`（minidb 读模型）+ `IAppendLogStore`/`IFileSystemStorageService`（事件文档）+ workspace lifecycle（live 判定）。Rust 引擎没有会话转录存储。

**结论**：算法作为库代码先行（供未来 Rust 存储层复用），工具本身落地需要「宿主数据桥」——与第 4 批 state bridge 同构的 host RPC（拉事件文档）或 state_read 扩展。这属于存储迁移工程，不是工具迁移。

### 3.5 Memory — 纯函数可移，存储可降级

`memoryPaths.ts`（114 行）是纯函数：路径约定（`memory/global|projects|sessions/`）、sha256 项目 id、markdown 类型检测/标题提取/摘要构建。`memoryTool.ts` 的渲染（search/read/list 输出）纯函数。存储层：`~/.kimi-code/memory/` 目录（纯文件，std::fs 可写）+ minidb 索引（全文搜索）。

**直移路径**：纯函数先行；工具壳直移（write 就是 mkdir + writeFile + 索引 put——Rust 侧索引可降级为启动时扫描 + 子串匹配，或复用 rusqlite FTS——同 Knowledge 的依赖决策）。main-agent-only 门控保留。

### 3.6 Agent — 格式化可移，完整工具依赖任务模型 + profile

Rust 已有 `subagent_tools.rs`（invoke_subagent/manage_subagents/define_subagent 原生执行 + `spawn_and_run`），但那是 v1 风格的子代理工具，与 v2 `Agent` 工具（`agentTool.ts` 630 行）语义不同：v2 支持 resume、background 任务注册、profile 目录、tool policy 门控、`display: agent_call`。

**可直移**：参数校验（resume+type 互斥、fork 门控、background 可用性门控）、三个格式化函数（≈60 行）、`buildProfileDescriptions`（profile 列表渲染，依赖 profile 数据）。**留 host**：profile catalog（宿主配置）、background 任务注册（`IAgentTaskService`——Rust 侧 task 工具已走 state bridge 模式，background 任务注册可同构）、resume（agent 实例持久化在宿主 session 元数据）。

### 3.7 lsp / run_code / Workflow / Tower / SelectTools — 长期留 host

- **lsp**：`LspService`/`LspInstance`/`LspConnection`/`LspStdioProvider` 是语言服务器子进程生命周期管理（`ISessionProcessRunner`）。Rust 侧 tokio::process 可起进程，但完整 LSP 客户端（JSON-RPC + 帧协议 + 服务器发现/配置/生命周期）是独立工程。仅渲染层（≈50 行）可移，价值小。
- **run_code**：`codeExecutor.ts` 用 `node:worker_threads` 执行 JS（`codeWorkerSource.ts` 是 JS 源码字符串）。Rust 无 JS 运行时，语义不可弥合。长期留 host。
- **Workflow**：`workflowRuntime.ts` 在 vm sandbox 里执行 JS DSL 脚本（agentHook/phaseHook/readFileHook 等），Rust 无对应物。长期留 host。
- **Tower 11 件**：`protocol/store.ts`（984 行）是 v1 逐字移植的 `.tower/` 文件协议（AGENTS.md 明令「不建议动」），`git.ts` 走 git CLI，TowerSpawn（407 行）依赖子代理生命周期 + rate limit + model catalog。ROADMAP 已定保持 host 侧。仅各工具壳的渲染可参考。
- **SelectTools**：薄壳（57 行），依赖 `IAgentToolSelectService`（工具加载/卸载 + 模型能力门控）。Rust 引擎工具集编译期固定，无运行时注册表概念。无直移价值。

## 4. 建议

### 值得直移（按优先级）

1. **Knowledge（完整直移）** — 存储已在 Rust，只做模块搬运 + 工具壳。前置是 Cargo 依赖决策（rusqlite bundled + once_cell，与 kimi-native-tools 同版本 0.32/1）。这是第四批性价比最高的一项。
2. **Team coordinator 逻辑（完整直移）** — `DiscussionContext` + 两个 coordinator + 渲染 ≈1100 行纯编排。前置是 `SubagentManager` persistent 化（P28 扩展：常驻实例多轮 run_turn + usage 聚合）。
3. **AgentRunBatch（完整直移）** — 646 行纯算法，零宿主依赖，可先行直移 + mock launcher 单测。launcher 实现随 SubagentManager persistent 化落地。
4. **session_query 纯逻辑 + Memory 纯函数（库代码先行）** — 无依赖、可完整单测；工具落地分别等宿主数据桥 / 存储决策。
5. **Agent 工具格式化/校验（纯函数先行）** — 依赖 background 任务模型（进行中）完成后接线。

### 长期留 host

- **lsp / run_code / Workflow**：进程/运行时独有能力，Rust 替代语义差异大或需独立工程。
- **Tower 11 件**：v1 协议逐字移植，AGENTS.md 明令不动。
- **SelectTools**：无独立逻辑，引擎工具集编译期固定。

## 5. 若直移的落码顺序

1. **Knowledge**（若批准 rusqlite 依赖）：复制 `kimi-native-tools/src/knowledge.rs` → `kimi-agent/src/knowledge/`，去 napi 化（`#[napi]` → `pub fn`，错误映射 `Result<T, String>`）→ 工具壳 `knowledge.rs`（action 分发 + 渲染，对齐 v2 文案）→ 注册进 `tools/mod.rs` 的 `handles()`/`execute_tool()` → 单测（schema 建库、add/search/confirm/reject/stats round-trip）。
2. **SubagentManager persistent 化**（Team/AgentSwarm 共同前置）：`spawn_persistent`（常驻实例，保留消息历史）+ `run_turn_on`（多轮）+ `usage()` 聚合 + `destroy`；对齐 v2 `PersistentSubagentHost` 接口语义。
3. **Team**：`context.rs`（DiscussionContext 直移 + 交叉引用正则）→ `coordinator.rs`/`debate_coordinator.rs`（编排直移，host 接口用 SubagentManager 实现）→ `team_tool.rs`（渲染 + 输入校验）→ 单测（mock host 跑讨论/辩论流程）。
4. **AgentRunBatch**：`swarm/agent_run_batch.rs`（launcher trait + 调度算法直移）→ 单测（并发限制/rate-limit 退避/取消，mock launcher）→ `agent_swarm_tool.rs`（launcher 接 SubagentManager）。
5. **session_query 纯逻辑**：`session_query/`（filters/search/cursor/lineage/渲染）→ 单测（golden 对齐 v2，参照 todo_item.rs 的逐字符对齐做法）；工具落地等宿主数据桥。
6. **Memory 纯函数**：`memory_paths.rs`（路径/类型/摘要纯函数）→ 单测；工具壳随存储决策（降级子串匹配或 rusqlite FTS）。
7. **Agent 工具格式化**：`agent_tool_format.rs`（三格式化函数 + 校验）→ 单测；完整工具等 background 任务模型 + profile 目录。

## 6. 验证说明

本任务为只读调研 + 报告撰写，**未修改任何 src/ 文件**，因此未运行 `cargo check`（无代码变更可验证）。所有结论基于对 `packages/agent-core-v2/src/agent/tools/{agent,team,select-tools}/`、`src/features/{swarm,sessionQuery,lsp,codeRuntime,tower}/`、`src/app/{memory,workflow}/`、`src/agent/knowledge/`、`packages/kimi-native-tools/src/knowledge.rs`、`packages/kimi-agent/`（ROADMAP.md、subagent/manager.rs、tools/mod.rs、tools/subagent_tools.rs、Cargo.toml）的代码阅读。

## 7. 遗留问题

- **调研报告勘误**：`rust-engine-state-tools-survey.md` 第 45 行称 Knowledge「addon 曾有 nativeKnowledge 但已随 kimi-native-tools 退场」——**与代码事实不符**：`kimi-native-tools/src/lib.rs` 仍 `mod knowledge;`，`knowledge.rs` 仍导出 7 个 `#[napi]` 函数，v2 `AgentKnowledgeService` 仍在调用。建议后续修正该报告。
- **Cargo 依赖决策**：Knowledge/Memory 完整直移需要 `rusqlite`（bundled）+ `once_cell` 加入 kimi-agent 依赖（kimi-native-tools 同款 0.32/1）。按「不新增依赖」约束，需单独决策。
- **SubagentManager persistent 化**是 Team/AgentSwarm 直移的共同前置，P28 `spawn_and_run` 只覆盖一次性后台执行。
- **session_query 工具落地**需要宿主数据桥（事件文档拉取），属于存储迁移工程范畴，非工具迁移。