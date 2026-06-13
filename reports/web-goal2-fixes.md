# kimi-web TODO 第二轮 · 结果汇报

> 范围：`apps/kimi-web`（Vue3 前端）。每条 TODO 对应一个 commit；改动均通过 `vue-tsc --noEmit`（0 错）+ `vitest run`（107 passed）+ `oxlint`（0 error），并对 UI 改动用 kimi-webbridge 在真实浏览器（stub daemon + vite）核对过。
>
> 基线：`c9f5a62d`（上一轮收尾）。本轮 19 个 commit：`71036ecd … 26ac63ec`。

整体测试基线从 99 → **107 passed**（新增 8 个用例：steer 去重、空 session 不闪、subagent 不污染父流、未读、通知、历史回溯、swarm 去重×2）。

---

## 逐条对应

### 1. 流式输出时刷新页面自动滚到底部 / thinking 块也到底部
**commit `bbe96ee5`** · `ThinkingBlock.vue`、`ConversationPane.vue`

- 根因①：thinking 块内部那个 5 行滚动窗口的 watcher 只在「已经在底部」时才跟随。刷新时整段 thinking 一次性出现、`scrollTop=0`，于是停在顶部。→ 给 streaming 的 thinking 块在挂载时直接滚到最新行。
- 根因②：整段 transcript 首次滚底发生在 markdown 高亮/图片异步布局**之前**，内容随后变高就停在半中间。→ 挂载后再多滚两帧（仅在仍 following 时），刷新可靠落到最新内容。

### 2.（高优先级）subagent 场景 chat 渲染碎片 + 大块骨架屏
**commit `b02810ae`** · `agentEventProjector.ts`（+ `subagent-goal.test.ts`）

- 根因：subagent 跑在**父 session id** 下，它自己的 `turn/step/delta/tool` 帧带着各自的 `agentId` 经**同一条** session 流推给 web；服务端构建快照的 `InFlightTurnTracker` 早已按 `agentId !== 'main'` 跳过这些帧，但 **web 的投影器没有按 agentId 过滤**。于是 subagent 的 `turn.step.started` 在父 transcript 里开了一条空的助手消息（= 大块「骨架屏」），它的 delta 又追加成零碎片段。
- 修复：web 投影器对「构建可见 transcript」的帧（turn/step/delta/tool/turn.ended/agent.status/prompt.completed）按 `agentId` 过滤非 main 的 subagent 帧，镜像服务端逻辑。subagent 进度仍走 `subagent.* → task → AgentCard`，不受影响。

### 3. 左上角新建对话按钮 + empty-composer 选 workspace
**commit `12fc9096`** · `Sidebar.vue`、`ConversationPane.vue`、`App.vue`

- 侧边栏头部加「新建对话」按钮（之前 `create` 事件**根本没有按钮触发**，是死的）→ 接到 `openWorkspaceDraft`。
- 空 composer 提示下方加 workspace 选择器（下拉列出所有工作区 + 路径，蓝色高亮当前），切换即进入目标工作区草稿。✅ 浏览器验证。

### 4. 去掉待办/后台任务的悬浮窗
**commit `527a07d8`** · 删除 `ConversationPane.vue` 的右上 `float-stack` 浮层 + 删除已无用的 `TasksCard.vue`。todos/后台任务仍在各自的 `~/todo`、`~/tasks` tab 里。✅ 浏览器验证（右上已无浮窗）。

### 5. 后台任务/待办尽量全显示，超出后滚动
**commit `4f979546`** · `TasksPane.vue`：去掉 `MAX_VISIBLE=5` 的「+N more」截断，渲染全部任务；列表 `flex:1 + overflow-y:auto`，超出在 pane 内滚动。待办的 tab 模式本就 `max-height:none`（已全显示）。

### 6. composer textarea 字号 13px → 14px
**commit `71036ecd`** · `style.css`：modern/kimi 主题下 `.ph` 的 13px → 14px（与 terminal 主题 14px 基线统一）。

### 7. 带图片 Steer 双 user message + steer 没插进去
**commit `1c13b810`** · `eventReducer.ts`、`useKimiWebClient.ts`（+ `steer.test.ts`）

- 根因①：reducer 用 `JSON.stringify(content)` 全等来匹配乐观消息和 daemon 回显。纯文本能精确匹配；图片在两端序列化不同（本地 `{source:{kind:'file',fileId}}` vs daemon 解析后的 URL/base64），匹配失败 → 追加成第二条。→ 改为**优先按 prompt_id 匹配**（提交时回填到乐观消息），再退回内容匹配。
- 根因②：乐观消息 id 用 `msg_opt_<Date.now()>`，同一毫秒内「排队发送 + steer」会撞同一个 id，导致 prompt_id 盖错消息。→ 改为单调计数器，每条乐观消息 id 唯一。

### 8. session title 左侧运行中 icon + 未读小蓝点
**commit `9aef7e94`** · `SessionRow.vue`、`useKimiWebClient.ts`（+ 测试）

- title 左侧的 gutter 槽位（原来只是占位空格）改成真正的状态槽：运行中显示页面风格的 SVG 旋转图标（替代原来的脉冲点），否则未读时显示蓝点。
- 未读跟踪：后台 session 完成一轮（非当前 session 的 `onSessionIdle`）置未读，选中即清除。

### 9. Fork session 功能
**commit `27e2f343`** · `SessionRow.vue`、`Sidebar.vue`、`App.vue`

- 后端 `POST /sessions/{id}:fork` + 客户端 `forkSession` + `/fork` 命令本就存在且可用，只是缺**可见入口**。→ session 行 kebab 菜单加「分叉会话」；`forkSession(id?)` 支持指定任意行（不只当前）。

### 10. 模式选择器(goal/swarm/plan) + goal 支持 + swarm 双渲染修复
**commit `f417d4dc`** · `Composer.vue`、`messagesToTurns.ts`（+ `agent-group-turns.test.ts`）

- **模式选择器**：input 底部的「计划」按钮换成「模式」弹窗，聚合 Plan（可用的客户端开关）/ Goal / Swarm，各自显示激活态（plan 开 / goal active · 时长 · 轮数 / swarm n/m），goal/swarm 激活时点击聚焦其卡片。弹窗用 `position:fixed`（否则被 composer 输入区盖住）。✅ 浏览器验证。
- **swarm 双渲染修复**：同一个多成员 swarm 既内联成 AgentGroup 又渲染成 SwarmCard（=「两块」）。→ `messagesToTurns` 对构成 swarm 的成员（>1 个带 `swarmIndex`，与 `buildSwarmGroups` 同口径）**跳过内联块**，只留 chat 流里的 SwarmCard。✅ 浏览器验证（只剩一块）。
- **⚠️ goal/swarm 的「启动」是后端缺口**：goal 创建是 JSON-RPC（`rpc.createGoal`），服务端 REST 层**没有暴露**；`/swarm on|off` 同理；且 daemon **不解析** prompt 里的 slash 命令。所以 web 目前只能**显示** goal/swarm 与其激活态（GoalStrip / SwarmCard 已有），**无法从 web 启动**。要真正支持需在 `packages/server` 加一条 REST 路由把 goal/swarm RPC 暴露出来——这超出前端范围，建议单独排。

### 11. 回溯功能（textarea 箭头上下翻历史）
**commit `42b84642`** · `Composer.vue`（+ `composer.test.ts`）

- shell 风格：ArrowUp 在**首行**回溯已发送消息，ArrowDown 在**末行**前进、到底恢复实时草稿；手动输入退出浏览。边缘行判断保证多行光标移动不受影响。提交/steer 时入栈（跳过连续重复）。

### 12. 新建 workspace 目录选择增强（默认路径 + fzf + 折叠绝对路径）
**commit `db248410`** · `AddWorkspaceDialog.vue`、`App.vue`

1. **默认路径**：浏览器默认打开 kimi-web 当前工作的路径（活动工作区 root，退回 $HOME）。
2. **fzf**：输入即在当前目录下做**有界递归**子序列模糊搜索（限深度/数量、防抖、可取消），按相对路径列出匹配目录；结果列表固定高度 → **搜索时窗口大小不变**。
3. **绝对路径输入折叠**为次选「直接输入绝对路径」按钮（daemon 无法浏览时自动展开）。

✅ 浏览器验证（默认定位到 …/code/kimi-code-web；搜「doc」命中 docs；折叠按钮）。

### 13. 点击空 session 不应闪一下 chat pane
**commit `59c2c19a`** · `useKimiWebClient.ts`（+ 测试）

- 根因：选中从未打开过的 session 时 `sessionLoading=true`，于是先渲染 chat pane（loading），快照（空数组）回来后才切到 empty-composer。→ daemon 报告 `messageCount===0` 的空 session 视作「没东西可等」，不置 `sessionLoading`，直接显示 empty-composer，不闪。非空 session 仍显示 loading。✅ 浏览器验证。

### 14. 完成时浏览器系统通知 + 设置开关
**commit `cafab7eb`** · `useKimiWebClient.ts`、`SettingsDialog.vue`、`App.vue`（+ 测试）

- 会话完成一轮且用户没在看它（页面隐藏或不是当前 session）时发系统通知；点击聚焦窗口并打开该 session。
- Settings 页加「会话完成时通知」开关；开启时请求 OS 权限，被拒则保持关闭；偏好持久化。✅ 浏览器验证（开关在设置里）。

### 15. Settings 页面独立
**commit `9de3efed`** · 新增 `SettingsDialog.vue`、`App.vue`、`Sidebar.vue`

- 设置原本挤在侧边栏账户 popover 里。→ 抽成独立的 Settings 模态（齿轮打开）：外观（主题/配色/强调色）、语言、通知、账户（provider/添加工作区/重新引导/登录登出）、高级（daemon 端点、导出日志）。删除侧边栏 popover 及其定位代码。✅ 浏览器验证。

### 16. chatpane 顶部 header（wp/ses 名 + git 分支状态 + 在 xx 打开 + 复制全部 + PR 状态）
**commit `be49a9b0`** · 新增 `ChatHeader.vue`、`ConversationPane.vue`、`App.vue`

- chat 上方加细条 header：workspace/session 面包屑、git 分支 + ahead/behind + 改动数、「在编辑器中打开」（daemon `fs:open` 工作区根）、「复制全部」（复用 `ChatPane.copyConversation`）。✅ 浏览器验证。
- **⚠️ GitHub PR 状态**：header 已留 PR 槽位（有数据时渲染、可点开），但 daemon 目前**不暴露 PR 状态**（需 GitHub API + remote 解析），所以暂传 `null`、优雅隐藏。后端接入 PR 数据后即可点亮。

### 17. 梳理 slash 命令并给删除建议
**commit `26ac63ec`**（删除 `/undo`）· 完整梳理见下

直接删了 1 个**确属失效**的：`/undo`——没有 daemon endpoint，点了只弹「未实现」警告，是死菜单项。其余给**建议**（未擅自删，等你拍板）：

| 命令 | 现状 | 建议 |
|---|---|---|
| `/help` | 关掉警告区 | **保留** |
| `/new` | 新建 session（现也有左上角按钮） | **保留**（命令仍便捷） |
| `/sessions` | 打开会话弹窗 | **保留** |
| `/clear` | 清空上下文 | **保留** |
| `/model` | 打开模型选择器 | **保留** |
| `/provider` | provider 管理 | **保留**（也可并入 Settings） |
| `/login` | 登录 | 可删：已有登录按钮 + Settings 入口，命令冗余 |
| `/permission` | 循环 manual/auto/yolo | **保留**（与权限 pill 等价，但命令更快） |
| `/plan` | 切计划模式 | **保留**（也在新「模式」弹窗里） |
| `/auto` | 权限设 auto | 可删：`/permission` + 权限 pill 已覆盖（仅是 shorthand） |
| `/yolo` | 权限设 yolo | 可删：同上（保留与否看是否要 power-user 快捷） |
| `/thinking` | 循环思考强度 | **保留** |
| `/compact` | 压缩上下文 | **保留** |
| `/fork` | 分叉（现也有 kebab 入口） | **保留** |
| `/status` | 打开状态面板 | 可删：新 chat header(T16) + 状态面板已展示同类信息 |
| `/undo` | 失效（仅警告） | **已删** ✅ |
| `/tasks` | 切到 tasks tab | **保留**（快捷切 tab） |

> 小结建议删除：`/undo`(已删)、`/auto`、`/yolo`、`/status`、`/login`（共 5 个，后 4 个等你确认）。理由统一是「已有等价 UI 入口且非高频」。

### 18. 归档逻辑统一（session + workspace）且 UI 不超出 title 左边界
**commit `bc14eac2`** · `SessionRow.vue`、`Sidebar.vue`、i18n

- 概念统一/澄清：session 是「**归档**」，workspace 是「**移除工作区**」（原来 workspace 菜单只写「删除」，读起来和 session 归档像同一回事）。
- UI：session 行的归档确认条保留左侧 gutter 槽位，对齐到 title 左边界，不再从行最左溢出。

### 19. 增加 console.log / export-log
**commit `977e638a`**（采集 + 导出函数）+ 在 T15 的 Settings 页加「导出日志」按钮 · `debug/trace.ts`、`DebugPanel.vue`

- 客户端 trace 原本只采集 `console.error/warn`，现采集**全部 console 级别**（log/info/debug），开启 trace 时导出的排障日志反映完整前端 console。
- 抽出可复用的 `downloadTraceLog()`（debug 面板 + Settings「导出日志」按钮共用）。✅ 浏览器验证（Settings 高级区有「导出日志」+「加 ?debug=1 开启采集」提示）。

---

## 两处需要后端配合的缺口（前端已就绪）

1. **T10 goal/swarm 启动**：服务端没把 goal/swarm 的 RPC 暴露成 REST，daemon 也不解析 prompt 里的 slash。web 已能显示 + 识别激活态，启动需要 `packages/server` 加一条 REST 路由。
2. **T16 GitHub PR 状态**：daemon 没有 PR 数据源。header 已留好插槽，接入后即点亮。

其余 17 条均已端到端落地并验证。
