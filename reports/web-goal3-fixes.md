# kimi-web 第三批 TODO 修复结果汇报

> 范围：`apps/kimi-web`（Vue3 前端）。共 16 条 todo，**每条一个 commit**。
> 基线 `b57f274a` → HEAD `225b2ded`，16 次提交。
> 验证：`vue-tsc` 0 错；`vitest` 22 文件 / 119 测试全过（基线 107，新增 12 个针对性用例）；`oxlint` 0 error。
> 关键 UI 改动用 stub daemon + vite + 真实浏览器核对过（见每条「验证」）。

---

## 总览

| # | TODO | 结论 | commit |
|---|---|---|---|
| 1 | 全部组件滚动条变细变淡 | 全局规则统一变细变淡 | `22e45803` |
| 2 | 输出完没正确滚到底 | 流结束边沿跨帧重新吸底 | `947e2e70` |
| 3 | 流式中刷新后月亮不转 | 月亮改由 `running` 驱动（刷新可恢复） | `8028cf44` |
| 4 | subagent 边距/刷新降级/可展开 | 修边距 + 卡片可展开看任务&结果 | `1fa155e5` |
| 5 | 预览应与对话/文件同级分屏 | 预览改为 SplitLayout 里的「预览」视图 | `225b2ded` |
| 6 | （高优）subagent 场景支持 | 从 transcript 重建卡片，刷新不降级 | `b6534c03` |
| 7 | 大量输出/切大 session 全屏骨架屏 | 关掉代码块的 loading 骨架（根因+规避） | `eaee45f2` |
| 8 | 后台任务时间不累加 & 点不开 | 运行时间每秒走动 + 行可点开看输出 | `c73e045e` |
| 9 | 带图片 Steer 双消息 & invalid mode | 前端去重修好；invalid mode 属后端 | `4f82b2f5` |
| 10 | 回溯历史唤不出/只回一条 | 进入浏览态后上下箭头直接翻历史 | `1f2a218b` |
| 11 | 提问/审批卡片：最小化+选项竖排+超时10分 | 最小化按钮 + 选项竖排；无超时逻辑 | `26d8a109` |
| 12 | 归档字体对齐 + workspace 仅移除 | 字号对齐 + 移除永远生效（不删历史） | `b6578506` |
| 13 | textarea 草稿按 session 存 localStorage | 每 session 草稿持久化、切回/刷新恢复 | `b72f5d31` |
| 14 | undo + 快捷编辑上一条 user 重发 | 接通 daemon `:undo` + 消息「编辑并重发」 | `3deed200` |
| 15 | 自动进计划模式后底部没激活 | 读 `agent.status.updated` 的 planMode 同步 | `c6550f72` |
| 16 | toolcall 空参数不显示在标题 | 空 `{}` 不进标题、详情仍显示 | `1298d50e` |

---

## 逐条说明

### 1. 全部组件滚动条变细变淡 · `22e45803`
**做了什么**：之前只有侧栏会话列表单独写了细滚动条，其它所有可滚动区域（聊天、后台任务、文件树、终端、各弹窗）都是系统默认的粗滚动条。在 `src/style.css` 加了一条**全局**规则：`scrollbar-width: thin` + `::-webkit-scrollbar` 宽 6px、轨道透明、滑块用半透明中性灰（在亮/暗背景都是淡淡一条，hover 略加深）。一处统一所有组件。
**验证**：浏览器加载后所有滚动区均为细淡滚动条。

### 2. 输出完成后没正确滚到底部 · `947e2e70`
**根因**：流结束的那一刻，内容还会在「最后一帧之后」继续变高——月亮/运行行被移除、流式 markdown 切到最终态重排、代码块异步高亮回流、复制按钮出现——这些都发生在观察器看到的最后一次变更之后，导致视图差一点没到底。
**做了什么**：`ConversationPane.vue` 加了对 `running` 由 true→false 边沿的监听，跨接下来几帧 + 250ms 兜底重新吸底（仅在用户仍处于「跟随底部」时，不会把翻看历史的用户拽下去）。

### 3. 流式中刷新后月亮不继续转 · `8028cf44`
**根因**：月亮指示器只看 `sending`（发送瞬间的乐观标志，刷新即丢）。正常情况下 `sending` 会一直为 true 直到 session idle，所以月亮全程显示；但刷新后这个内存标志没了，即使 session 还在 `running` 也不显示。
**做了什么**：`ChatPane.vue` 把月亮条件从 `sending` 改成 `sending || running`。`running` 来自 session 实时状态，刷新后能恢复，于是月亮继续转；正常流程下行为完全不变（`sending` 期间结果一致）。

### 4. subagent 边距/刷新降级/可展开 · `1fa155e5`
**根因（边距）**：桌面 line-turns 布局的块间距规则里有 `.agent-card`/`.agent-group`，但 Modern/Kimi 和手机用的 **bubble 布局（`.a-msg`）漏了** agent 卡片，于是 subagent 卡片紧贴上一个块、没有间距。
**做了什么**：
- 补齐 `.a-msg` 的块间距规则，把 `.agent-card`/`.agent-group` 纳入。
- `AgentCard.vue` 增加展开内容：之前只有有 summary/suspendedReason 才能点开，现在带上**子任务的 prompt（Task）和结果（Result）**，working 中也能点开看。
（「刷新不降级」由第 6 条实现，二者一起交付。）

### 5. 预览应与对话/文件同级、像分屏按钮 · `225b2ded`
**根因**：文件/媒体预览原来在 App 右侧一个**独立面板**弹出，游离在 ViewGroup/SplitLayout 视图体系之外。
**做了什么**：新增 `preview` 视图类型；桌面打开预览时**像分屏按钮一样把布局 split**，预览作为「预览」tab 出现在新视图组里、与对话/文件平级，可在该组内切换其它 tab、可用关闭按钮收起；预览是临时视图，刷新不持久化。移动端无分屏，仍用全屏侧面板。涉及 `usePaneLayout`(openPreview/closePreview)、`TabBar`/`ViewGroup`(条件预览 tab)、`ConversationPane`(预览 pane + props)、`App.vue`(桌面走 pane、移动走侧面板)。
**验证**：浏览器点聊天里的 `api/client.ts` 链接 → 布局分裂成两个视图组，右侧出现高亮的「预览」tab 并渲染文件内容（截图核对）。

### 6.（高优）subagent 场景支持 · `b6534c03`
**根因（刷新降级）**：前台 subagent **从不作为后台任务持久化**，刷新后 `listTasks` 里没有它；而前端原来只靠实时事件产生的 task 才把 `Agent` 工具调用渲染成卡片，刷新后没了 task → 退回成普通 toolcall 卡片。（顺带查明：protocol 的 `backgroundTaskSchema` 本身也没有 `parent_tool_call_id`，所以后台 subagent 刷新也连不上。）
**做了什么**：`messagesToTurns` 里，当某个 `Agent` 工具调用没有匹配的实时 task 时，**直接从持久化的 transcript（工具输入 + toolResult）重建 AgentCard**——transcript 是持久化的，所以刷新后自然恢复成卡片，且带上 prompt + 完整结果（比 task 的短预览更全）。swarm（`AgentSwarm`）仍走 SwarmCard、不误伤。
**验证**：单测 `agent-group-turns.test.ts` 新增「无 task 时从 transcript 重建」用例；浏览器里 swarm 卡片只渲染一块。

### 7. 大量输出/切大 session 全屏骨架屏 · `eaee45f2`
**根因**：markstream 代码块在 `!stream && loading` 时显示骨架占位，而它的 `loading` prop **默认 true**，我们从没传过——于是每个非流式（历史/已完成）代码块都要等 shiki 异步高亮完才显示内容；一屏代码同时挂载（切大 session / 快速输出）时 shiki 跟不上，骨架就卡住，整页变占位。
**做了什么**：`Markdown.vue` 给 `code-block-props` 固定 `loading: false`。非流式代码块立即显示纯文本 fallback、shiki 就绪后再升级为高亮，**保留语法高亮、彻底消除骨架**；流式块不受影响（其 `stream` 为 true，本就不进骨架分支）。

### 8. 后台任务运行时间不累加 & 点不开 · `c73e045e`
**根因（时间）**：`toUiTask` 用 `Date.now()` 只算一次，`tasks` 只在任务数据变化时重算，运行中任务的时间不会走动。
**做了什么**：
- `useKimiWebClient` 加一个**仅在有运行中任务时**每秒滴答的时钟，让 `tasks` 重算，运行时间持续累加。
- `TasksPane.vue` 任务行**可点击展开**（带箭头），展开看 meta + 输出（输出来自实时进度事件；REST 当前不返回任务输出，见下）。

### 9. 带图片 Steer 双消息 & invalid mode · `4f82b2f5`
**根因（双消息）**：daemon 的 `messageCreated` 回显可能在 `submitPrompt` 返回、把 prompt_id 盖到乐观消息**之前**就到达；此时既没 prompt_id 可匹配，图片内容又因序列化不同（fileId vs 解析后的 URL）匹配不上 → 回显作为第二条 user 气泡出现。
**做了什么**：`eventReducer` 的去重加一条**宽松回退**：按「文本 + 图片数量」匹配，无论回显先到后到都能并回乐观消息。单测 `steer.test.ts` 新增「回显不带 prompt_id 也去重」用例。
**后端缺口**：`prepare image failed / invalid mode` 是后端/模型对图片**模式**（CMYK/调色板等）预处理失败，前端只负责上传 fileId，正常发送与 steer 发送的内容格式完全一致——这条属后端图片预处理问题，不在前端范围。

### 10. 回溯历史唤不出/只能回一条 · `1f2a218b`
**根因**：回溯一条多行历史项后，光标落到该项的最后一行，而「ArrowUp 仅在第一行触发」的判断就把它卡住了，再按上键不再回溯。
**做了什么**：`Composer.vue` 改为**一旦进入浏览态（historyIndex 已设）就直接用上下箭头翻历史**，不再受光标行限制；输入文字才退出浏览态、箭头恢复移动光标。单测 `composer.test.ts` 新增「越过多行历史项继续回溯」用例。

### 11. 提问/审批卡片：最小化 + 选项竖排 + 超时10分 · `26d8a109`
**做了什么**：
- `QuestionCard`/`ApprovalCard` 都加了**临时最小化按钮**（折叠成一条标题栏、显示问题/操作预览，不再一直挡屏；折叠时屏蔽数字快捷键避免误选）。
- 提问选项的**标题与解释改为上下竖排**（`.qopt-text` 列布局），长解释不再把标题横向挤成多行细列。
- **超时**：排查后**代码里并无提问/审批超时逻辑**（`ask-user` 工具无限等待用户），所以「改 10 分钟」无对象、无需改动。
**验证**：浏览器触发提问卡片 → 最小化按钮存在、点击可折叠（显示问题预览）、选项为标题在上解释在下的竖排（截图核对）。

### 12. 归档字体对齐 + workspace 仅移除 · `b6578506`
**做了什么**：
- `SessionRow` 的「归档会话?」确认文字字号调到与普通 session title 一致（14px），位置本就在同一起点，现在大小/基线也对齐。
- `useKimiWebClient.deleteWorkspace` 改为：**移除永远生效**（即便还有会话）。原来会因「有会话」拒绝（daemon 的 DELETE 只删注册表，`mergedWorkspaces` 会从会话 cwd 把它推导回来）。现在把 root 记入**持久化的隐藏集合**，合并时跳过它——**不删任何会话/历史**，只从侧栏移除；重新添加同路径会取消隐藏。

### 13. textarea 草稿按 session 存 localStorage · `b72f5d31`
**做了什么**：`Composer` 加 `sessionId` prop；输入时把草稿按 `kimi-web.draft.<sessionId>` 实时存 localStorage，切回该 session / 刷新页面自动恢复，发送或 steer 后清空（新会话用 `__new__` 键）。单测 `composer.test.ts` 覆盖按 session 存取 + 发送后清空。

### 14. undo + 快捷编辑上一条 user 重发 · `3deed200`
**做了什么**：
- 接通 daemon 的 `POST /sessions/{id}:undo`：`client.undo(count)` 撤销后重新拉 snapshot 同步本地 transcript；恢复了 `/undo` 命令。
- 在**最新一条 user 消息**上加「编辑并重发」按钮：点击后撤销上一轮交互，并把该消息文本回填到 composer 供编辑后重发（通过 ConversationPane 暴露的 `loadComposerForEdit`）。
**验证**：浏览器里 user 气泡下方可见「编辑并重发」按钮（截图核对）。

### 15. 自动进计划模式后底部没激活 · `c6550f72`
**根因**：agent 通过 `agent.status.updated` 事件**已经上报了 planMode**（protocol 里该事件就有 `planMode` 字段，agent-core 也发），但前端投影器只取了 `swarmMode`、漏了 `planMode`。
**做了什么**：照着 swarmMode 的现成链路补一条 planMode：投影器从事件取 planMode → 随 `sessionUsageUpdated` 携带 → 同步进状态；`GET /status` 也一并读取。这样 agent 自动进/出计划模式，底部模式选择器会跟着亮。单测 `start-session-and-send.test.ts` 新增 plan 模式同步用例。

### 16. toolcall 空参数不显示在标题 · `1298d50e`
**做了什么**：`toolMeta.toolSummary` 对空参数（`{}`/`[]`/空串/无键对象）在**标题（非 full 模式）返回空**，不再把噪音 `{}` 塞进标题；**展开详情（full 模式）仍显示**。单测 `tool-summary.test.ts` 覆盖空参数标题为空、详情仍有、非空参数照常。

---

## 需要后端配合的点（前端已就绪/已规避）
- **N9 `invalid mode`**：后端/模型图片预处理对某些图片模式失败，需在 daemon/上游处理（如上传前归一化为 RGB）。前端双消息已修。
- **N6 后台 subagent 刷新**：`protocol.backgroundTaskSchema` 缺 `parent_tool_call_id`、agent-core 的 `AgentBackgroundTaskInfo` 也未带，故后台 subagent 刷新后无法用 task 连回工具调用。前端已用 transcript 重建覆盖前台 subagent（最常见）；后台 subagent 刷新若要显示真实运行态，需后端补这些字段。
- **N8 任务输出**：daemon 的 `toProtocolTask` 当前不返回任务输出（连 `output_preview` 都未映射），任务展开里的输出只来自实时进度事件；要刷新后仍可查看历史输出，需后端在 REST 返回输出。
