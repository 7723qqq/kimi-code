# Rust 引擎状态与交互类工具迁移调研（第 7 批前置）

> 状态：调研完成（只读代码，未改任何 src/ 文件）
> 范围：`packages/agent-core-v2/src/agent/tools/` 全部工具目录 + `src/features/` 下 tower/swarm/todo/plan/goal/cron/skill/sessionQuery/lsp/codeRuntime 等 feature 工具
> 目标：为 kimi-agent（纯 Rust 引擎）第 7 批「状态与交互类工具」迁移提供工具清单、依赖分类与优先级建议
> 关联：`packages/kimi-agent/ROADMAP.md` P21 排序计划（第 4 批 = 反向交互协议 + 状态层归属 + 子代理递归；第 7 批依赖第 4 批）

## 1. 工具清单总表

### 1.1 `src/agent/tools/`（12 个工具目录）

| 工具 | 实现位置 | 状态依赖（state key / 服务） | 交互依赖 | 迁移可行性 |
|---|---|---|---|---|
| Agent（子代理） | `agent/agentTool.ts` | `IAgentLifecycleService`（agent 生命周期）、`ISessionSubagentService`、`IAgentTaskService`（taskKey）、`ISessionAgentProfileCatalog`、`IAgentProfileService`、`IAgentToolRegistryService`、`ISessionMetadata`、`AgentToolContribution` collection、`IConfigService`/`IFlagService` | `display: agent_call`（宿主 UI 卡片）；前台模式阻塞等待子代理完成 | **中**（Rust 已有 `subagent/SubagentManager` + `tools/subagent_tools.rs`，`InvokeSubagent` 已原生执行；但 resume/背景任务/display 仍依赖宿主） |
| AskUserQuestion | `ask-user-question/askUserQuestionTool.ts` | `ISessionQuestionService`（→ interaction runtime，见 §3.1）、`IAgentTaskService`（background 模式注册 QuestionBackgroundTask）、`IAgentToolPolicyService`（TaskList/Output/Stop 门控）、`ITelemetryService` | **强**：question 请求 → 宿主 UI 展示 → 等用户回答（`requestSessionInteraction` 挂起直到 resolve） | **低**（核心是反向交互协议，第 4 批协议落地前无法迁移） |
| Team | `team/teamTool.ts` | `IPersistentSubagentService`、`IAgentSwarmService`（swarmKey）、`IAgentScopeContext` | `display: agent_call`；内部跑 TeamCoordinator/StructuredDebateCoordinator 多轮子代理讨论 | **低**（子代理编排 + display；coordinator 逻辑可直移但宿主子代理递归是第 4 批前置） |
| SelectTools | `select-tools/selectToolsTool.ts` | `IAgentToolSelectService`（工具加载/卸载状态，模型能力门控 `enabled()`） | 无 UI 交互，但依赖宿主工具注册表与模型能力判定 | **低**（工具注册表是宿主核心，Rust 侧无对应物；工具本身是薄壳） |
| TaskList | `task/task-list/taskListTool.ts` | `IAgentTaskService`（taskKey，replayable + undoable 通知投递） | 无 | **中**（读操作，格式化纯函数可直移；task 注册表需 Rust 侧任务模型） |
| TaskOutput | `task/task-output/taskOutputTool.ts` | `IAgentTaskService`（getOutputSnapshot，输出持久化在宿主磁盘） | 无 | **中**（输出快照依赖宿主持久化路径） |
| TaskStop | `task/task-stop/taskStopTool.ts` | `IAgentTaskService`（stop/suppressTerminalNotification） | 无 | **中**（停止语义需 Rust 任务模型支持） |
| WaitFor | `task/task-wait/taskWaitTool.ts` | `IAgentTaskService`（wait/list/getOutputSnapshot）、`ITelemetryService`；`onUpdate` 进度回调（ToolUpdate status） | `ctx.onUpdate` 进度流（宿主 UI 展示） | **中**（等待循环可直移；进度回调走 host/event 即可） |
| Edit / Read / Write / Grep / Glob / Bash | `os/*`、`edit/` | 纯 I/O | 无 | **已完成**（第 2/3 批，Rust `tools/mod.rs` 已原生执行） |
| FetchUrl / WebSearch / GitHub / ReadMediaFile | `fetch-url/`、`web-search/`、`github/`、`read-media-file/` | 纯 I/O | 无 | **第 6 批范围**（fetch_url.rs/web_search.rs 已存在；github/read-media-file 待搬） |

### 1.2 `src/features/` 下 feature 工具

| 工具 | 实现位置 | 状态依赖（state key / 服务） | 交互依赖 | 迁移可行性 |
|---|---|---|---|---|
| TodoList | `features/todo/tools/todo-list/todoListTool.ts` | `AgentTodo` runtime（todo 状态，durable `ToolsUpdateStore` 事件 + **undoable**）、`IAgentToolPolicyService`（reminder 注册） | 无 UI 交互；todo 提醒走 AgentReminder 注入（host 侧已有） | **中**（状态层归属是第 4 批前置；读/写/渲染逻辑纯函数可直移） |
| EnterPlanMode | `features/plan/tools/enter-plan-mode/enterPlanModeTool.ts` | `IAgentPlanService`（planKey，replayable + **undoable**）、`ITelemetryService` | 无 UI 交互（auto 进入）；plan 文件路径来自宿主 | **中**（状态层 + 宿主 plan 文件） |
| ExitPlanMode | `features/plan/tools/exit-plan-mode/exitPlanModeTool.ts` | `IAgentPlanService`、`IAgentPermissionModeService`（auto 判定）、`ITelemetryService` | **强**：`display: plan_review`（宿主 UI 展示 plan + 用户批准）；非 auto 模式必须等用户 | **低**（反向交互协议前置；auto 模式可本地直通） |
| CreateGoal | `features/goal/tools/create-goal/createGoalTool.ts` | `AgentGoal` runtime（goal 状态，durable 非 undoable）、`IAgentPermissionModeService` | `display: goal_start`（非 auto 模式宿主 UI 展示目标） | **中**（状态层前置；display 可降级为纯文本） |
| UpdateGoal | `features/goal/tools/update-goal/updateGoalTool.ts` | `AgentGoal` runtime、`stopTurn`/`stopBatchAfterThis` 语义 | 无 UI 交互 | **中**（状态层前置；stopTurn 需 turn loop 支持） |
| GetGoal | `features/goal/tools/get-goal/getGoalTool.ts` | `AgentGoal` runtime | 无 | **中**（纯读 + 序列化，最易） |
| SetGoalBudget | `features/goal/tools/set-goal-budget/setGoalBudgetTool.ts` | `AgentGoal` runtime（预算状态） | 无 | **中**（预算计算纯函数可直移；状态层前置） |
| CronCreate / CronList / CronDelete | `features/cron/tools/cron-{create,list,delete}/` | `AgentCron` runtime（cron 状态，durable 非 undoable）、`IAgentScopeContext`（main-agent-only） | 无 UI 交互；cron 触发投递在宿主 | **中**（cron 表达式解析/渲染是纯计算可直移；调度器状态层前置） |
| Skill | `features/skill/tools/skillTool.ts` | `ISessionSkillCatalog`（skill 目录，workspace/session 状态）、`AgentSkill` runtime（激活记录）、`ISessionContext` | **强**：`delivery: { kind: 'steer' }`（把 skill 内容作为消息注入上下文，宿主转录/steer 队列） | **低**（steer 注入依赖宿主消息队列；目录加载是宿主 workspace 能力） |
| session_query | `features/sessionQuery/sessionQueryTool.ts` | `ISessionQueryService`（→ `ISessionIndex` + `IWorkspaceLifecycleService` + `IAppendLogStore` + `IFileSystemStorageService`，宿主存储/索引）、`ISessionContext`（cwd/sessionId）、main-agent-only | 无 UI 交互 | **低**（搜索/索引/事件存储全是宿主独有存储层；纯查询逻辑可参考） |
| AgentSwarm | `features/swarm/tools/agent-swarm/agentSwarmTool.ts` | `ISessionSwarmService`（swarm 任务编排）、`ISessionSubagentService`、`IAgentSwarmService`（swarmKey）、`IAgentProfileService`、`IConfigService`/`IFlagService` | `display: agent_call`；批量子代理 spawn/resume | **低**（子代理递归 + display；第 4 批前置） |
| TowerInit / TowerPlan / TowerSpawn / TowerStatus / TowerMerge / TowerTeardown / TowerReview / TowerSend / TowerMission / TowerInbox / TowerFinding（11 个） | `features/tower/tools/*/` | `TowerStore`（`.tower/` 协议文件：state/inbox/findings/reviews/activity log，用户仓库内）、`IAgentTowerService`（towerKey/towerOwnerKey，replayable）、`ITowerRateLimitService`、`ISessionManager`、`ISessionContext`（cwd）；TowerSpawn 额外依赖 `IAgentLifecycleService`/`ISessionSubagentService`/`IAgentTaskService`/`IModelCatalog` | TowerSpawn 启动子代理（后台任务）；其余无 UI 交互 | **低**（协议文件 + git CLI + 子代理 spawn 全是宿主/仓库能力；协议本身是 v1 逐字移植，不建议动） |
| lsp | `features/lsp/tools/lsp/lspTool.ts` | `ILspService`（语言服务器进程生命周期：lspInstance/lspConnection/lspStdioProvider）、`ISessionContext`（cwd） | 无 UI 交互 | **低**（LSP 进程管理是宿主独有能力；查询渲染纯函数可参考） |
| run_code | `features/codeRuntime/runCodeTool.ts` | `IConfigService`（sandbox policy）、`node:worker_threads` 执行 | 无 UI 交互 | **低**（worker_threads 是 Node 独有能力；Rust 侧需 wasm/子进程替代，语义差异大） |
| Memory | `app/memory/tools/memoryTool.ts` | `IMemoryStore`（文件系统 + 全文索引）、`IBootstrapService`（homeDir）、`ISessionContext`、main-agent-only | 无 UI 交互 | **低**（宿主存储层：memoryDir 文件 + 索引；写文件逻辑可直移但存储归属是宿主） |
| Workflow | `app/workflow/tools/workflow.ts` | `IWorkflowService`（workflow 运行编排）、`IAgentLifecycleService`/`ISessionSubagentService`（子代理）、`IBootstrapService`、main-agent-only | 无 UI 交互；run/wait 阻塞 | **低**（子代理编排 + 宿主 workflow 注册表） |
| Knowledge | `agent/knowledge/tools/knowledge-tool.ts` | `IAgentKnowledgeService`（知识库存储/搜索）、main-agent-only | 无 UI 交互 | **低**（宿主存储；addon 曾有 nativeKnowledge 但已随 kimi-native-tools 退场） |

## 2. 三分类

### A. 依赖反向交互协议（引擎 → 宿主发问/展示并等回答，不阻塞 step 循环）

第 4 批要建的协议在 v2 的对应物是 `features/interaction/`（`InteractionRequestEvent`/`InteractionResolvedEvent` 持久化事件 + pending map + resolve emitter，`sessionInteractions.ts` 提供 request/enqueue/respond/list 面；`session/question/questionService.ts` 是它的第一个消费者）。

| 工具 | 反向交互点 | 说明 |
|---|---|---|
| **AskUserQuestion** | `question.request()` 挂起直到用户回答/关闭 | 最典型；background 模式另注册 QuestionBackgroundTask（task 状态） |
| **ExitPlanMode** | `display: plan_review` + 非 auto 模式等用户批准 | auto 模式可本地直通（`permissionMode.mode === 'auto'` 分支已存在） |
| **CreateGoal** | `display: goal_start`（非 auto 模式） | 可降级为纯文本输出，非硬依赖 |
| **Skill** | `delivery: { kind: 'steer', message }` 反向注入消息 | 依赖宿主 steer 队列（`host/drain_steers` 已有对应 seam） |
| **Team / AgentSwarm / Agent** | `display: agent_call`（宿主 UI 卡片） | display 是展示层，可降级；真正的依赖是子代理递归（第 4 批第三地基） |

### B. 依赖状态层持久化（todo/plan 的持久化 + undo 语义）

第 4 批要建的「状态层归属」在 v2 的对应物是 Agent Runtime 机制（`defineAgentRuntimeContract` + durable 事件 + replayable/undoable state key）：

| 工具 | 状态 | 持久化/undo 语义 |
|---|---|---|
| **TodoList** | todo（`ToolsUpdateStore` 事件） | durable + **undoable**（`context.undo` 回滚） |
| **EnterPlanMode / ExitPlanMode** | planKey（`planOps.ts:84`） | replayable + **undoable** |
| **CreateGoal / UpdateGoal / GetGoal / SetGoalBudget** | goal（`GoalRuntimeState`） | durable，undoable: false |
| **CronCreate / CronList / CronDelete** | cron（`CronTask[]`） | durable，undoable: false |
| **TaskList / TaskOutput / TaskStop / WaitFor** | taskKey（`taskOps.ts:77`）+ taskNotificationDeliveryKey | replayable + undoable（通知投递）；task 注册表本身是世界时间状态（非 undoable） |
| **Tower 11 件** | towerKey/towerOwnerKey（replayable）+ `.tower/` 文件协议 | 主要状态在用户仓库 `.tower/` 目录，非引擎状态 |
| **AgentSwarm / Team** | swarmKey（replayable） | 模式开关，非核心 |

### C. 纯计算可直移（无宿主状态/交互依赖，或仅依赖可本地化的存储）

| 工具/模块 | 可直移部分 | 备注 |
|---|---|---|
| **cron 表达式** | `parseCronExpression` / `cronToHuman` / `computeNextCronRun` / `hasFireWithinYears`（`features/cron/internal/cron-expr.ts`） | 纯函数，Rust 侧无依赖，可先行移植 + 单测 |
| **goal 序列化/预算** | `tools/serialize.ts`（goalForModel/goalResultForModel）、`setGoalBudgetTool` 的预算换算/合理性校验 | 纯函数 |
| **todo 渲染** | `todoItem.ts` 的 `readTodoItems`/`renderTodoList` | 纯函数 |
| **task 格式化** | `agent/task/tools/format.ts`（formatPlainObject）、TaskList/TaskOutput 输出拼装 | 纯函数 |
| **sessionQuery 查询逻辑** | `filters.ts`/`search.ts`/`cursor.ts`/`lineage.ts` 的过滤/分页/谱系算法 | 可参考移植，但数据源（ISessionIndex/事件存储）在宿主 |
| **lsp 渲染** | `lspTool.ts` 的 renderResult/renderLocations/renderHover | 纯函数，查询本身依赖宿主 LSP 进程 |
| **tower 渲染** | status/plan 的表格渲染 | 纯函数，数据源在 `.tower/` 协议 |

## 3. 迁移优先级建议

### 第一批（现在可做，零前置依赖）：纯计算内核直移

1. **cron 表达式解析/渲染**（`cron-expr.ts` 全套）→ Rust `src/tools/` 或独立 `src/cron/` 模块。纯函数、有明确输入输出、可完整单测。CronCreate/CronList 的校验逻辑（5 年窗口、one-shot 上限、字节上限）随之可移。
2. **goal 序列化与预算换算**（`serialize.ts` + `set-goal-budget.ts` 的 normalizeBudgetInput/budgetLimitsFromInput/toMilliseconds）→ Rust。注意与 ROADMAP 4.8 节 D1/D2/D5 的口径决策对齐（objective 上限、token 记账）。
3. **todo 渲染**（`readTodoItems`/`renderTodoList`）与 **task 格式化**（`formatPlainObject`）→ Rust 纯函数，供后续状态层工具复用。

> 这些是「工具内部逻辑」而非「工具本身」，先落地可让第 7 批后续工作只写状态/协议接线。

### 第二批（依赖第 4 批「状态层归属」）：状态类工具

第 4 批状态层（todo/plan 持久化 + undo 语义）落地后：

1. **GetGoal / TodoList / CronList**（纯读 + 渲染，状态层就绪即可直移）
2. **UpdateGoal / SetGoalBudget / CronCreate / CronDelete**（写状态 + stopTurn/stopBatchAfterThis 语义；需 turn loop 支持 stopTurn 标志）
3. **EnterPlanMode**（planKey 状态 + 宿主 plan 文件路径；无 UI 交互）
4. **TaskList / TaskOutput / TaskStop / WaitFor**（需 Rust 侧任务模型：注册表 + 输出快照 + 停止语义；WaitFor 的进度回调走 `host/event` 即可）

### 第三批（依赖第 4 批「反向交互协议」）：交互类工具

第 4 批反向交互协议（Rust 版 interaction runtime：request/enqueue/respond + 非阻塞 step 循环）落地后：

1. **AskUserQuestion**（最典型消费者；background 模式依赖任务模型）
2. **ExitPlanMode**（plan_review display；auto 模式可先行本地直通）
3. **Skill**（steer 注入；`host/drain_steers` seam 已存在，需扩展为「引擎发起 steer」）
4. **CreateGoal**（goal_start display 降级为纯文本后可不依赖协议）

### 第四批（依赖宿主独有能力，建议长期保留 host 路径或仅移植渲染层）

1. **session_query**（宿主 ISessionIndex/事件存储；查询算法可参考移植到 Rust 存储层，但那是存储迁移工程，非工具迁移）
2. **Memory / Knowledge**（宿主文件存储 + 索引；写文件逻辑简单但存储归属是宿主）
3. **lsp / run_code**（宿主进程管理：LSP 语言服务器 / worker_threads；Rust 替代方案语义差异大）
4. **Tower 11 件**（`.tower/` 协议 + git CLI + 子代理 spawn；ROADMAP 已定协议是 v1 逐字移植、保持 host 侧）
5. **Team / AgentSwarm / Workflow / Agent**（子代理编排；Agent 已有 Rust 侧 `subagent_tools.rs` 基础，但 resume/背景任务/display 依赖宿主；第 4 批「子代理递归」落地后 Team/AgentSwarm 的 coordinator 逻辑可移）
6. **SelectTools**（宿主工具注册表 + 模型能力判定，无独立可移逻辑）

## 4. 关键结论

1. **第 7 批 25 个工具中，约 6 个（cron 表达式、goal 序列化/预算、todo 渲染、task 格式化）的纯计算内核现在就能直移**，不依赖第 4 批。
2. **约 9 个状态类工具（todo/plan/goal/cron/task 族）依赖第 4 批「状态层归属」**（durable + undoable 语义）；其中 GetGoal/TodoList/CronList 等纯读工具在状态层就绪后最易迁移。
3. **约 4 个交互类工具（AskUserQuestion/ExitPlanMode/Skill/CreateGoal）依赖第 4 批「反向交互协议」**；v2 的 `features/interaction/`（InteractionRequestEvent/ResolvedEvent + pending/resolve）是协议的直接参照实现，`session/question/questionService.ts` 是第一个消费者。
4. **约 10 个工具（sessionQuery/memory/knowledge/lsp/codeRuntime/tower 11 件/team/swarm/workflow/select-tools）依赖宿主独有能力**（存储层、进程管理、子代理编排、工具注册表），建议保留 host 路径，仅按需移植渲染/查询纯函数。
5. **Agent 工具已有 Rust 侧基础**（`subagent/SubagentManager` + `tools/subagent_tools.rs` 的 InvokeSubagent/ManageSubagents/DefineSubagent），第 4 批「子代理递归」完成后 Team/AgentSwarm 的 coordinator 逻辑（TeamCoordinator/StructuredDebateCoordinator 是纯编排算法）可整体直移。

## 5. 验证说明

本任务为只读调研 + 报告撰写，**未修改任何 src/ 文件**，因此未运行 `cargo check`（无代码变更可验证）。所有结论基于对 `packages/agent-core-v2/src/agent/tools/`、`src/features/` 及 `packages/kimi-agent/`（ROADMAP.md、callbacks.rs、rpc/types.rs、tools/mod.rs）的代码阅读。