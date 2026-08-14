# kimi-web 与 deepseekharness Web 前端差距报告

- **日期**: 2026-08-15
- **对比对象**:
  - kimi-web — `apps/kimi-web`（Vue 3 + Vite SPA，通过 daemon REST + WebSocket 通信）
  - deepseekharness web — `G:\deepseekharness\apps\web` + `packages/client/*`（React 18 插件化 GUI，cordis 插件树，host RPC + WebSocket 事件流）
- **方法**: 两个 explore 子代理并行产出功能清单后逐项交叉比对；路径引用以探索时（2026-08-15）工作树为准
- **状态**: 只读对比产物，不修改任何源码

> 与 `docs/deepseek-harness-fusion.md`（引擎层能力移植记录）互补：本文档只覆盖 **Web UI 层**，引擎层移植决策见该文档。

## 总体结论

两个前端基础功能高度重叠：会话流渲染、工具调用卡、审批、用户提问、模型/effort 选择、权限模式、Plan/Swarm/Goal 模式、消息队列、统计行、上下文环、compaction、归档/fork、Workspace 管理均有对应实现。kimi-web 在认证、移动端、附件多样性、审批类型覆盖、队列管理、文件预览、Git 集成、通知体系上**明显更强**；差距集中在四块：**子代理体系（目录树/续聊/血统聚合）**、**Trajectory 审计视图**、**消息反馈与对话细节（重试行/注入行/产物文件行）**、**配置体系（Agent Preset / 插件配置页）**。

## 功能对比矩阵

状态图例：**一致**（双方都有、能力相当）| **更强**（该侧更完整）| **缺失**（另一侧没有对应物）| **部分**（有雏形但明显不完整）

### 会话管理

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| 会话列表（状态点/未读/待交互徽标） | `SessionRow.vue` | `ui-workspace/rows` | 一致 |
| 新建会话（draft、workspace 选择） | `ConversationPane.vue` | `ui-sidebar` + `ui-workspace` | 一致 |
| 会话重命名 / fork | 内联重命名、`client.ts:709` | `session.rename` / `session.fork` | 一致 |
| 会话搜索 | Spotlight（Ctrl+K，标题+prompt 过滤）`SearchSessionsDialog.vue` | 标题匹配 + 250ms 防抖内容搜索（排名/snippet） | 更强（dsh） |
| 归档 | 归档 + **恢复** + 归档浏览 tab | 仅归档，**无取消归档 UI** | 更强（kimi-web） |
| 导出会话 ZIP（含诊断日志） | `client.ts:588` | 无 | 更强（kimi-web） |
| 会话 URL 深链 `/sessions/<id>` | `lib/sessionRoute.ts` | 无事件深链（仅浏览器标题投影） | 更强（kimi-web） |
| **子代理目录树**（血统/状态/token/时长/导航进子会话） | 无（仅 AgentTool 卡被动展示） | `ui-subagent/SubagentCatalogAction.tsx` | **缺失** |
| **子代理续聊**（FIFO inbox、独立 Stop、`@` 引用源） | 无 | `ui-subagent/SubagentReadOnlyComposer.tsx` | **缺失** |
| **侧边栏子代理血统聚合**（子会话运行指示继承） | 无 | `sessions/subagent-lineage.ts` | **缺失** |
| 子会话列表/创建（API 层） | `listChildSessions` 已实现，**UI 事件未接线**（stub） | 子代理体系完整 | 缺失（有基础） |

### 对话渲染

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| Markdown（katex/mermaid/高亮/文件链接） | `chat/Markdown.vue` | `ui-primitives`（shiki/KaTeX） | 一致 |
| Thinking 块折叠 + 实时摘要 | `ThinkingBlock.vue` | Think 行折叠 + 推理摘要 | 一致 |
| Compaction 行（折叠/摘要） | `ChatPane.vue` | `CompactionItem.tsx` | 一致 |
| 消息时间戳 / 复制 | `MessageTime.vue` | 时钟/复制 | 一致 |
| 上下文环 / 统计行（turns·耗时·TTFT·吞吐·缓存命中） | `ContextRing.vue` + `StatsLine.vue`（fusion 第 2 轮移植） | `ContextMeter.tsx` + `StatsLine.tsx` | 一致 |
| 附件 chips（图片/视频/文件、预览） | `AttachmentChip.vue` | 仅图片 rail + 画廊 + lightbox | 更强（kimi-web） |
| 会话大纲 TOC | `ConversationToc.vue` | 无 | 更强（kimi-web） |
| 编辑并重发上一条消息 | 有（undo + 载入 composer） | 已发送消息**不可编辑**（明确决定） | 更强（kimi-web） |
| **消息反馈 Like/Dislike + 备注** | 无 | `ui-message-feedback`（CAS 冲突协调） | **缺失** |
| **上下文注入行**（跨会话召回/注入来源 producer 标注） | 无 | `ContextInjectionRow.tsx` | **缺失** |
| **Turn 重试状态行**（倒计时/shimmer/失败展开） | 无 | `ui-conversation/chat/`（重试行） | **缺失** |
| **max-tokens 截断提示 + 继续指引** | 无 | `conversation-nodes/`（持久提示） | **缺失** |
| **Steering 气泡**（进行中指引以用户气泡展示、claimed 并入） | 仅 Ctrl+S 注入（无气泡形态） | `ui-conversation` steering 气泡 | 缺失（部分） |
| **产物文件行**（turn 尾部自动识别文件 chips、Show in folder） | 无（附件 chips 是输入侧） | `ui-deliverables/ProducedFiles.tsx` | **缺失** |
| 错误/turn 结束提示 | `WarningToasts.vue`（toast 形态） | turn-error 持久提示（AUTH 脱敏） | 部分 |

### 输入 Composer

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| 自动增高 / Enter 发送 / Shift+Enter 换行 | `Composer.vue` | `ui-conversation/input` | 一致 |
| 输入历史（↑/↓ 按会话隔离） | `useInputHistory.ts` | 草稿机（跨 workspace 保留） | 一致 |
| 消息队列（排队/编辑/删除/拖拽排序/steer） | `useWorkspaceState.ts:1781` 完整队列 | 队列（**编辑仅文本**） | 更强（kimi-web） |
| 附件（粘贴/拖放/上传进度） | 图片+视频+文件 | 仅图片 | 更强（kimi-web） |
| `/` 命令菜单、`@` 文件引用 | `SlashMenu.vue` + `MentionMenu.vue` | `ui-commands` + `ui-input-trigger` | 一致 |
| 技能面板/`/skill:` 调用 | `SkillPanel.vue` | `ui-skill`（`/` 触发落地文本） | 一致 |
| IME 组合输入处理 | 有（`Composer.vue:407`） | — | 更强（kimi-web） |
| **Enter 行为可配置**（busy 时 Queue/Steer） | 固定 Enter=排队 | 设置行 + Cmd+Enter 另一行为 | 缺失（部分） |

### 工具调用展示

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| 工具卡注册表/通用卡回退 | `toolRegistry.ts` + `GenericTool.vue` | 工具调用树 + keyed slot | 一致 |
| Edit/Write 内联 diff（±统计/展开/详情面板） | `EditTool.vue` + `ToolDiffPanel.vue` | diff 意图卡（多文件） | 一致 |
| 子代理卡（实时进度流） | `AgentTool.vue` + `AgentDetailPanel.vue` | 子代理树（见会话域） | 部分 |
| Swarm/Workflow 卡（阶段概览、成员折叠） | `SwarmTool.vue` | `ui-workflow-run`（run/phase/member 折叠） | 一致 |
| AskUserQuestion 结果回填 | `AskUserTool.vue` | question 卡 | 一致 |
| 媒体工具卡（图片/视频/音频） | `MediaTool.vue` | —（terminal/read/search 更细） | 各有所长 |
| **terminal ANSI 光标回放卡** | `Terminal.vue`（xterm 全实现）**未接入 UI，孤儿组件** | terminal 意图卡（ANSI/光标回放） | 缺失（有基础） |
| read 行号+高亮 / search grep/glob 意图卡 | 通用卡（50 行截断） | 专用意图卡 | 更强（dsh） |
| 工具耗时/状态点/分组堆叠 | `ToolRow.vue` / `StatusDot.vue` / `ToolGroup.vue` | 工具调用树递归 | 一致 |

### 审批与提问

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| 审批卡类型覆盖 | 10 种类型全渲染（diff/shell/file/url/search 等） | 占位条（allow/refuse） | 更强（kimi-web） |
| 批准/拒绝/反馈/Revise/快捷键 1-4 | 全支持 | 一次性 allow/refuse（无反馈/revise） | 更强（kimi-web） |
| **持久授权范围**（会话级批准范围） | 有（`useWorkspaceState.ts:1990`） | 无（仅 allow-once） | 更强（kimi-web） |
| 提问卡（单选/多选/自由文本/推荐项） | `QuestionCard.vue` | `QuestionComposer.tsx`（+plan-review 评审卡） | 一致 |
| 计划评审（plan-review 意图） | `types.ts` ApprovalBlock | `PlanReviewPanel.tsx`（Chat about it/Refuse/Approve） | 一致 |

### Agent 状态与任务

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| `/status` 状态面板（模型/权限/上下文/花费） | `StatusPanel.vue` | 无独立面板 | 更强（kimi-web） |
| 后台任务列表 | `ChatDock` + `TasksPane`（**可停止**、输出可看、复制） | `ui-jobs` popover（**只读**、无输出流） | 更强（kimi-web） |
| Todo 列表（工具写覆盖、只读） | `TodoCard.vue` | `TodoPanel.tsx`（单行截断） | 一致 |
| 浏览器通知 + 声音（3 类开关） | `useNotification.ts` | 无 | 更强（kimi-web） |
| 浮动警告 toast（可复制详情） | `WarningToasts.vue` | turn-error 持久行 | 一致 |
| **Trajectory 视图**（turn 感知事件台账 + 时间线缩放 + Inspector） | 无（仅 `?debug=1` KAP 开发面板） | `ui-trajectory`（第二页签、虚拟化分页） | **缺失** |

### Workspace 与文件

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| Workspace 增删改/分组/拖拽排序 | `Sidebar.vue` + `workspaceOrder.ts` | `ui-workspace`（分组/扁平、拖拽） | 一致 |
| 目录选择 | daemon 目录浏览 + 搜索 + 路径校验（`AddWorkspaceDialog.vue`） | 原生 OS 对话框（loopback）+ Miller 列浏览（新建文件夹/隐藏项） | 更强（dsh） |
| 文件预览（代码/Markdown/JSON/图片/视频/PDF/HTML/CSV/二进制） | `FilePreview.vue` 全格式 | —（打开经 host 编辑器） | 更强（kimi-web） |
| Git 状态（分支/ahead-behind/增删行/PR 徽章） | `ChatHeader.vue` + `DiffView.vue` | 无 | 更强（kimi-web） |

### 设置与配置

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| 设置面板（外观/Agent/账户/高级/归档 5 tab） | `SettingsDialog.vue` | `ui-settings-general`（section 导航） | 一致 |
| 主题（light/dark/system + accent + 字号） | `useAppearance.ts` | `ui-theme`（首帧注入防闪） | 一致 |
| 语言切换（i18n） | en/zh 30 namespace | zh/en 字典（navigator 探测） | 更强（kimi-web） |
| Provider 管理（添加/密钥/baseUrl/刷新/OAuth） | `ProviderManager.vue` | Models 页（credentials.set + discoverModels 探测 + DeepSeek 引导） | 更强（kimi-web 有 OAuth 刷新；dsh 有 discoverModels） |
| **Agent Preset 管理**（复制/默认/删除/只读 viewer/broken 标记） | 无 | `ui-agent-preset/AgentPresetSection.tsx` | **缺失** |
| **插件配置页**（bash/agent-loop/web-search 配置卡 + 插件清单） | 无（skill 面板只管技能激活） | `ui-settings-plugins` + `ui-settings-plugin-inventory` | **缺失** |
| **打开配置文件**（host 原生编辑器打开 settings.yaml） | 无 | `SettingsDocumentAction.tsx`（loopback） | **缺失** |
| Onboarding 引导 | `Onboarding.vue`（语言+主题+accent，可跳过） | 设置内 onboarding 步骤序列 | 一致 |

### 模式、认证与移动端

| 功能 | kimi-web | deepseekharness | 状态 |
|---|---|---|---|
| 权限模式（manual/auto/yolo + 危险色） | 有（`useWorkspaceState.ts:2259`） | 有（+ danger-full-access 确认模态） | 一致 |
| Plan / Swarm / Goal 模式 + Goal 条 | `GoalStrip.vue` + 模式开关 | `ui-plan` / `ui-goal` GoalBar | 一致 |
| BTW 侧聊（独立 mini-agent） | `SideChatPanel.vue` | 无 | 更强（kimi-web） |
| 认证 | OAuth 设备码 + 服务端 token + 登出 | **无认证层**（仅 trustedHosts 围栏，loopback 特权方法） | 更强（kimi-web） |
| 移动端布局（≤640px） | `MobileTopBar.vue` + sheets | 无（仅窄视口让步链） | 更强（kimi-web） |
| 消息反馈同步 | 无 | `ui-message-feedback`（跨 tab CAS） | 缺失（见对话域） |

## 缺失功能清单（kimi-web 相对 deepseekharness）

按"价值 × 缺口大小"分三档；实现建议基于 kimi-web 现有架构（无路由库、组件 + 事件中枢模式）。

### 高价值差距

1. **子代理目录树 + 子代理续聊**
   - 上游：`packages/client/ui-subagent/`（目录树 `SubagentCatalogAction.tsx`、续聊 `SubagentReadOnlyComposer.tsx`、血统 `sessions/subagent-lineage.ts`）
   - kimi-web 现状：`AgentTool.vue` 卡只做进度展示；`listChildSessions` / `createChildSession` API 层已存在但 **App.vue / ConversationPane.vue 未绑定事件**（stub）
   - 建议：先接上子会话列表/创建事件链，再做目录树面板（侧边栏或详情面板）；续聊需要 daemon 侧确认子代理 inbox 语义
2. **Trajectory 视图**
   - 上游：`packages/client/ui-trajectory/`（事件台账 + 时间线 + Inspector + 虚拟化分页）
   - kimi-web 现状：仅有 `?debug=1` 的 KAP 调试面板（`debug/DebugPanel.vue`，开发用环形缓冲），无用户可见审计视图
   - 建议：基于已有 WS 事件流（`agentEventProjector`）做只读台账页签；时间线缩放/虚拟化可后置
3. **消息反馈 Like/Dislike + 备注**
   - 上游：`packages/client/ui-message-feedback/`（CAS 版本冲突协调）
   - kimi-web 现状：无；需要 daemon 侧确认是否存在 feedback 收集端点（引擎层已有反馈收集基建，fusion.md 提及）
   - 建议：消息操作栏加 Like/Dislike + 可选备注，持久化走服务端
4. **上下文注入行**
   - 上游：`packages/client/ui-conversation/src/client/chat/ContextInjectionRow.tsx`（角色 + producer 标注、默认折叠）
   - kimi-web 现状：只有 compaction 摘要；BTW 侧聊的上下文继承无来源标注
   - 建议：在消息流中识别注入型事件，渲染可折叠来源行；需 daemon 事件字段支持
5. **产物文件行**
   - 上游：`packages/client/ui-deliverables/ProducedFiles.tsx`（turn 尾部文件 chips + Show in folder + 行内代码文件提及可点击）
   - kimi-web 现状：`AttachmentChip.vue` 是输入侧附件；文件链接在 Markdown 渲染里可点，但无 turn 级产物聚合
   - 建议：客户端从 turn 事件里收集 Edit/Write 结果的文件路径，渲染为 turn 尾部 chips

### 中价值差距

6. **Turn 重试状态行** — 上游 `ui-conversation/chat/`（跨重试稳定行、倒计时、shimmer、失败详情）；kimi-web 无重试概念，需引擎侧重试事件支持
7. **max-tokens 截断提示 + 继续指引** — 上游 `conversation-nodes/`；kimi-web 需识别 max-tokens 结束事件并给"继续"操作
8. **Steering 气泡** — kimi-web 已有 Ctrl+S 注入能力，补一个"注入的下一步指引"气泡展示即可（上游 steering 气泡 claimed 后并入）
9. **Agent Preset 管理** — 上游 `ui-agent-preset/`；kimi-web 无 preset 概念，属架构性功能（预设=模型+权限+thinking+plan 的命名组合），需服务端 preset 存储支持
10. **插件配置页** — 上游 `ui-settings-plugins/`；kimi-web 的插件管理在 CLI 端，web 端仅技能激活（`SkillPanel.vue`），需要 daemon 暴露插件配置端点
11. **terminal ANSI 回放卡** — 上游 terminal 意图卡；kimi-web 的 `Terminal.vue`（xterm.js）+ `useTerminal.ts` + 服务端 `listTerminals`/`createTerminal` 均已实现但**无组件引用**，接线即可

### 低价值 / 小项

12. **打开配置文件** — 上游 `SettingsDocumentAction.tsx`；kimi-web 可在 Advanced 设置加"打开 settings.yaml"，需 daemon 支持 host 打开
13. **侧边栏子代理血统聚合** — 上游 `subagent-lineage.ts`；依赖 #1 落地后顺带实现
14. **Enter 行为可配置** — 上游 `EnterBehaviorRow.tsx` + `submission-settings.ts`；kimi-web 队列已固定 Enter=排队，加设置项即可
15. **会话内容搜索增强** — 上游有 250ms 防抖内容搜索（排名/snippet/上限 20）；kimi-web Spotlight 只搜标题+最近 prompt，可扩展为内容搜索（引擎层 `session_query` 工具已移植，可复用服务端能力）

## 反向优势（kimi-web 强于 deepseekharness）

- **认证体系**：OAuth 设备码登录 + 服务端 token + 登出（dsh 无认证层，仅 trustedHosts 围栏）
- **移动端布局**：≤640px 独立顶栏/切换 sheet/设置 sheet（dsh 仅窄视口让步链）
- **附件多样性**：图片/视频/文件上传 + 进度 + 预览（dsh 仅图片）
- **审批**：10 种类型全渲染、反馈/Revise、数字键快捷键、会话级持久授权范围（dsh 仅一次性 allow/refuse）
- **消息队列**：可编辑/删除/拖拽排序/自动发送（dsh 队列编辑仅文本）
- **文件预览**：10 种格式（dsh 无内置预览）
- **会话管理**：归档恢复、导出 ZIP（含诊断日志）、undo、URL 深链（dsh 无取消归档）
- **Git 集成**：分支状态、ahead/behind、变更 diff 面板、PR 徽章（dsh 无）
- **任务列表**：可停止、输出可看、命令复制（dsh 只读）
- **BTW 侧聊**：不占会话列表的 mini-agent（dsh 无）
- **通知体系**：浏览器通知 + 声音、三类独立开关（dsh 无）
- **i18n**：en/zh 各 30 namespace（dsh 仅 zh/en 字典）

## 附录：双方未完成项

### kimi-web 已发现的 stub / 未完成（与 deepseekharness 无关）

- `Terminal.vue`（xterm 全实现）+ `useTerminal.ts` + 服务端 terminal API 全部就绪，但**无组件 import**——孤儿组件
- `ChatHeader.vue` 的"创建子会话/打开子会话"菜单项事件未绑定（`listChildSessions` API 可用但 UI 无响应）
- `types.ts:167` 注释称 ApprovalCard 只 fallback generic——实际 10 种类型已全部实现，注释过时
- 移动端 settings sheet 无 `/status`、队列入口（桌面功能子集）
- 遥测开关依赖服务端实现，提示重启生效

### deepseekharness 自身缺失（供参考）

- 无认证层 / 无 TLS / 无 SSE 回退；远程部署仅 trustedHosts 围栏
- 无会话删除/取消归档 UI；已发送用户消息不可编辑
- 附件仅图片（无文件、无上传进度、lightbox 无缩放）
- 后台任务只读（无取消、无输出流）
- 远程浏览器下设置/凭据不可用（loopback-only，远程仅内存模式）
- 无移动端布局；`openDetails` 详情面板未接线；子代理目录无完成/失败标记
