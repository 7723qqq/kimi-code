# TUI2 完整替代开发要求（KimiTUI v2 交互版）

> 目标：**用 opentui + SolidJS 完整替代 v1 的 pi-tui 交互层**——不是静态预览，而是真实可交互的 KimiTUI（键盘输入、实时流式渲染、编辑器、对话框、会话管理全链路）。

> **进度状态（2026-08-27 校对）：分支 `tui2/rebased`（0.38.0）已进入 polish 阶段。tui2/skeleton 历史工作已通过 `e9f0ddcbcd feat(tui2): rebase the opentui v2 TUI onto the current main` 链合并入主线，并经过 8 个 polish commit（`dc954498a3`..`c9d7527df0`）将 `apps/kimi-code/src/tui2/` 的 oxlint 警告从 ~427 砍到 ~155、修复了一类公开 API 的 promise/always-return 边界、闭合了 AgentSwarm 渲染 gap、清理了 4 个 stash 中的 3 个。下文反映 rebased 的当前真实状态。**

## 一、最终目标形态

| 项 | v1（现状） | v2 目标 |
|---|---|---|
| 渲染框架 | pi-tui（`render(width): string[]` 字符串） | opentui（Yoga 布局树） |
| 组件 | class + ANSI 字符串 | SolidJS 函数组件（返回 JSX） |
| 状态 | `TUIState`（命令式 Container/addChild） | 响应式状态（SolidJS signals，`state.tsx` store） |
| 交互 | pi-tui 事件循环 | opentui `createCliRenderer` + `useKeyboard` |
| 入口 | `tui/kimi-tui.ts` | `tui2/kimi-tui.ts`（opentui 版） |
| 运行时 | Node | Bun（opentui 的 bun:ffi） |

**运行前提（已实测）**：opentui 渲染只能在 Bun 下工作（Node 缺 `node:ffi`）。完整交互必须在真实终端用 Bun 跑。

## 二、已完成（分支 `tui2/rebased` 当前真实状态）

**核心进度指标**
- `apps/kimi-code/src/tui2/` 文件结构稳定；`scripts/audit-tui2.mjs` 22 项检查中 19 / 22 通过（2 项为 stash-survey / working-tree-dirty 状态信号，1 项预期 2 个 prefer-literal-regex 衍生已修）。
- `pnpm --filter @moonshot-ai/kimi-code run typecheck:tui2` 通过（tsconfig.tui2.json — noEmit，TS6.0.2 严格模式 + `noUncheckedIndexedAccess`）。
- `test/tui2/` 共 **40 个测试文件（456 用例）**，全部在 `bun --bun ./node_modules/.bin/vitest run` 下绿。详单：dispatch、host-actions、store-patch、store-isolation、goal-swarm-resolve、goal-queue-manager、tasks-browser-refresh、agent-swarm-progress、btw-panel-spread、streaming-ui、transcript-navigation、clipboard-image-hint、cache-hint-controller、editor-keyboard、workflow-panel、subagent-activity-store、subagent-event-handler、plugin-update-notifier、session-replay、auth-flow、session-event-handler、skeleton、agent-pane-status、agent-swarm-progress、tool-renderers、cache-hint-controller、goal-queue-manager、slash-command-resolve、kimi-tui-queue-drain、compaction-view、device-code-card、editor-input-probe、theme、tool-renderers。
- oxlint `apps/kimi-code/src/tui2` 0 errors、~155 warnings（已修：escape-case 191→0、consistent-type-imports 7→0、prefer-string-slice 5→0、prefer-string-replace-all 5→0、prefer-string-replace-all 衍生 2→0、prefer-code-point 15→4（4 处 charCodeAt 已加 `?? 0` fallback）、prefer-at 1→0、no-array-sort 1→0、no-immediate-mutation 4→0、no-duplicates 4→0、prefer-native-coercion-functions 2→0、promise/always-return 7→0、import/first 21→0；剩 ~155 主要为 no-non-null-assertion 101 + no-useless-undefined 40 + require-await 25 等需要公开 API 协调或类型退化的项）。
- sherif 0 errors（`packages/kimi-build` 的工作区排除告警是预期配置，不计入）。

**阶段 A — TUIState 地基（完成）**
- `tui2/state.tsx`：SolidJS 响应式 response store，替代 v1 命令式 Container 树。
- `tui2/tui-state.ts`：转发层，指向 `state.tsx`，保持调用方 import 不变。
- `tui2/config.ts`、`types.ts`：框架无关，已真实化。

**阶段 B — controllers 移植（完成）**
- `tui2/controllers/` 共 **14 个**控制器，已从 pi-tui 命令式改为写 response store + opentui reconciler：
  `streaming-ui`、`session-event-handler`、`session-replay`、`transcript-navigation`、`editor-keyboard`、`auth-flow`、`btw-panel`、`cache-hint-controller`、`clipboard-image-hint`、`plugin-update-notifier`、`subagent-activity-store`、`subagent-event-handler`、`tasks-browser`、`workflow-panel`。

**阶段 C — 入口渲染器（完成）**
- `tui2/kimi-tui.ts` → `controllers/kimi-tui.ts`（真实 opentui 协调器）。
- `run.tsx`（KimiTUI host）、`entry.tsx`、`context.tsx`、`event.ts`、`dispatch.ts`、`goal-queue-store.ts`、`keybindings.ts`、`keymap.ts` 均已落地。
- `KIMI_TUI=v2` 通过 CLI env 分发接线完成。
- `demo-interactive.tsx` 为开发验证入口（转发 v1 demo），供真实终端跑通交互循环。

**阶段 D — 组件 opentui/SolidJS 重写（基本完成）**
| 目录 | 状态 |
|---|---|
| `components/editor` | 真实：custom-editor（opentui）、file-mention-provider、wrapping-select-list |
| `components/media` | 真实：code-highlight、diff-preview、image-thumbnail |
| `components/panes` | 真实：activity、agent、btw-panel、queue、diff-review-pane |
| `components/dialogs` | 真实：approval-panel/approval-preview、choice-picker、compaction、editor-selector、experiments-selector、goal-queue-manager、goal-start-permission-prompt、help-panel、model-selector、permission-selector、provider-manager、question-dialog、session-picker、settings-selector、theme-selector、task-output-viewer |
| `components/messages` | 真实：agent-group、assistant-message、agent-swarm-progress、background-agent-status、plan-box、read-group、shell-execution、skill-activation、status-message、swarm-markers、thinking、tool-call（含 tool-renderers）、usage-panel、user-message、goal-markers 等 |
| `components/chrome` | 真实：banner、footer/todo-panel/welcome/moon-loader/device-code-box（`.ts`→`.tsx`） |
| `components/common` | 转发层到 `.tsx`（box/button/clickable/spacer/text） |
| `dialogs dispatch` | completes 15/15 wired；goal/swarm/queue/undo pick\* 已接真实 controller 流 |

## 三、剩余工作（真实待办，按优先级）

### 待办 1：清理残留对 v1 `tui/` 的 8 处模块引用
含义：这些 tui2 组件仍直接 `import` v1 `tui/`，绕过 tui2 自身实现，破坏"tui2 自包含"。
- [x] `utils`：`image-thumbnail.tsx`
- [x] `theme`：`code-highlight.ts`
- [x] `diff`：`diff-review-pane.tsx`、`dialogs/approval-panel.tsx`、`dialogs/approval-preview.tsx`
- [x] `commands/goal.ts`
- 结果：`git grep "@moonshot-ai/pi-tui" -- apps/kimi-code/src/tui2` 已无结果；tui2 指向 v1 `src/tui/` 的仅剩 README 说明文字。

### 待办 2：降低对 `@moonshot-ai/pi-tui` 的依赖 ✅（21 处 → 0）
已全部镜像/自建到 tui2（提交见下），工具、类型、运行时能力全部自包含，`typecheck:tui2` + lint 通过：
- 工具：`utils/fuzzy.ts`、`utils/width.ts`（自包含，零外部依赖）、`utils/keys.ts`（Kitty 协议等）
- 类型/实现：`utils/autocomplete.ts`、`utils/combined-autocomplete.ts`（fd 补全）、`utils/terminal-image.ts`（终端图像/能力）、`utils/screen-takeover.ts`（no-op 自包含）、`host mountEditorReplacement` 类型放宽为 `unknown`
- 代价：`keys.ts`/`combined-autocomplete.ts` 等为 pi-tui 算法副本，会双份维护、随 pi-tui drift。

### 待办 3：阶段 E — 运行时落地（核心剩余项，需先定分发决策点）
现状缺口：CLI 的 `cli/run-shell.ts` v2 分支只 `new KimiTUI().start()`，**未接 `runKimiTui2`**（createCliRenderer + render 的 opentui reconciler）；且 opentui 只能在 Bun 渲染。故 `KIMI_TUI=v2` 在 Node 下无法渲染 opentui UI。
- [ ] 决定分发方式（见决策点 1）。→ **方案 A 已实证可行**（见下）。
- [x] **v2 分支改为走 `runKimiTui2`**（2026-08-21）：
  - `cli/run-shell.ts` 抽出 `startupInput`、引入结构类型 `TuiSurface`（v1/v2 共用），`exitHandler` 参数化读 `tuiSurface`；`KIMI_TUI=v2` 时 `await runKimiTui2({ harness, startupInput, onExit })`，onExit 收到 opentui host 后换入 `tuiSurface` 走同一退出/telemetry/stty 路径。
  - `tui2/run.tsx` `RunKimiTui2Options.onExit` 签名改为 `(host, exitCode?)`，让 CLI 在 host 存在时即可读会话/退出状态（`runKimiTui2` 在真实终端只会在 renderer 销毁后才返回）。
  - 主 tsconfig typecheck + lint + tui2 117 测试通过。
- [ ] 给 `#/*` 涉及包配 Bun 兼容 paths（apps/kimi-code + node-sdk 等）。✅ apps/kimi-code 已配（tsconfig.json `"#/*": ["./src/*"]`）；node-sdk 等按需。
- [x] **Bun 打包 tui2 成单二进制 —— 已实证**（2026-08-21）：
  - `bun build apps/kimi-code/src/tui2/entry.tsx --compile`（49 模块）→ 单 `.exe`；`KIMI_TUI2_BOOT_CHECK=1` 运行输出 `TUI2_ENTRY_BOOT_OK`（exit 0）。分发方案 A（Bun 单二进制与 Node SEA 并存）可行。
  - 固化脚本 `apps/kimi-code/scripts/tui2/build-entry.mjs`（`node scripts/tui2/build-entry.mjs` → `dist/tui2/tui2-entry[.exe]`），接入 npm scripts `build:tui2` / `dev:tui2`。
- [x] **修复 CLI v2 链路 `Tui2StoreProvider missing`（2026-08-21，本次会话）**：
  - **根因**：bun 原生 JSX 编译立即求值 children，`<ShellView />` 在 `Tui2ProviderStack` 组件体执行**之前**就被求值执行，Provider 组件从未被调用（`Tui2StoreProvider` 无日志即证据），`useTui2Store()` 自然拿不到 context。
  - **二次根因**：`@opentui/solid` 的 `bun-plugin-solid` 是唯一能惰性化 children 的机制（babel-preset-solid），但 root `package.json` 的 `pnpm.overrides` `"@babel/core": ">=7.29.6"` 把其 `@babel/core@7.28.0` 提升为 **8.0.1**，babel-preset-solid 报 "Requires Babel ^7.0.0-0" 而插件失效。
  - **修复**：
    1. root `package.json` overrides 增加 `"@opentui/solid>@babel/core": "^7.29.6"`，`pnpm install` 后 opentui/solid 依赖回退到 `@babel/core@7.29.7` + `babel-preset-solid@1.9.12`（lockfile 已核对）。
    2. `cli/run-shell.ts` v2 分支在 `import('#/tui2/index')` **之前** `await import('@opentui/solid/preload')`（注册 bun 插件 + 内建 `#/tui2/run` 路径复用；原 301 行的晚注册因 tui2 模块已加载而无效）。preload 无类型声明 → 行内 `@ts-expect-error`。
    3. `scripts/tui2/build-entry.mjs` 从 `bun build --compile` 改为 `Bun.build` + `@opentui/solid/bun-plugin`（bunfig preload 只对 `bun run` 生效，`bun build` 必须在编译期显式传插件）；`build:tui2` 脚本从 `node` 改 `bun`（插件是 Bun-only）。
  - **验证**：`KIMI_TUI=v2 KIMI_TUI2_BOOT_CHECK=1 bun apps/kimi-code/src/main.ts` 输出 `TUI2_ENTRY_BOOT_OK`（无 Provider 错误）；编译出的 `dist/tui2/tui2-entry.exe` boot check 亦通过；117 个 tui2 测试全绿；`tsc -p tsconfig.json` typecheck 通过；lint 0 error。

### 待办 4：真实终端交互验证 + 测试补全
- [x] `demo-interactive.tsx` 已是真实 opentui 交互演示；`bun src/tui2/demo-interactive.tsx`（`KIMI_TUI2_BOOT_CHECK=1`）实测输出 `TUI2_SKELETON_BOOT_OK`。
- [x] `streaming-ui.test.ts`（10 用例，vitest）——thinking/assistant 缓冲合并、tool-call 生命周期、Agent/Read 分组、max_tokens 截断、turn 终态派发。**测试发现并修复真实 bug**：分组时对尚未 push 的 entry 调 `patchEntry(entry.id, groupKey)` 是 no-op，导致分组内第 2 条及之后 entry 缺失 groupKey；改为 `pushTranscriptEntry({ ...entry, groupKey })`。
- [x] `transcript-navigation.test.ts`（9 用例）——可导航 kind 过滤、环回移动、Expand 切换、j/k/↑↓/Enter/Esc 键映射、deactivate 清除 navigated。**测试暴露并修复 store 隔离缺陷**：`createTui2Store()` 用 `...INITIAL_RUNTIME` 浅拷贝，嵌套切片（transcriptNav/livePane/btwPanel…）在所有 store 实例间共享引用，改一个会污染其他新建 store；改为 `structuredClone(init)`（`state.tsx`），并新增 `store-isolation.test.ts`（2 用例）固化回归。
- [x] `clipboard-image-hint.test.ts`（4 用例）——启动静默建基线、焦点后仅对新图提示、显示窗口后清除、同图不重复提示后可 re-arm、模型不支持图像时零剪贴板读取。剪贴板读取用 `vi.mock` 替换（避免真读系统剪贴板），真实定时器用假定时器驱动 debounce/display 窗口。
- [x] `cache-hint-controller.test.ts`（11 用例）——截断 submiss 的同步 guard 矩阵（engineV2/无 session/无活动/无 OAuth provider/偏好关闭/streaming/compacting/60s 新鲜度窗口）与 prompt-cache-break 检测（`noteStepUsage` 骤降追踪、稳定不追踪、全零跳过）。异步 fetch/hint 路径留给真实终端 smoke。
- [x] `entry.tsx` 真实产品入口的 boot-check **已实测**：`KIMI_TUI2_BOOT_CHECK=1` + `bun apps/kimi-code/src/tui2/entry.tsx` 输出 `TUI2_ENTRY_BOOT_OK`（exit 0）。**修复 boot 逻辑 bug**：原实现 `await render()` 之后才 `renderer.destroy()`，而 opentui 的 `render()` 要等 destroy 才 resolve，形成死锁 → 标记永不打、进程挂住；改为在 `await render` 前用 setTimeout 排程 destroy+标记（与 `run.tsx` 一致）。
- [x] **CLI v2 链路 boot-check 已实测**（2026-08-21）：`KIMI_TUI=v2 KIMI_TUI2_BOOT_CHECK=1 bun apps/kimi-code/src/main.ts` 走完整 run-shell → runKimiTui2 → opentui reconciler → MainShell 渲染链路，输出 `TUI2_ENTRY_BOOT_OK`（无 `Tui2StoreProvider missing`）。此前一直失败的原因是 bun 未加载 solid 变换插件（见待办 3 修复记录）。
- [ ] 跑通 `KIMI_TUI=v2` 真实终端交互（streaming/editor/dialog 全链路）——boot check 已过，剩余真实键盘/渲染冒烟由你在真实终端运行 `bun apps/kimi-code/src/main.ts`（KIMI_TUI=v2）确认。
- [x] `editor-keyboard.test.ts`（12 用例）——submit 路由、Ctrl+C/Ctrl+D 双击退出（含 cancInFlight、非空 draft、streaming 时只清 draft）、Esc 取消除/双击开 undo、change 清 pending exit、Shift+Tab 懒建会话（v2）与 v1 报错、有会话立即切 plan。
- [x] `workflow-panel.test.ts`（12 用例）——非 Workflow 工具忽略、坏 args 忽略、run+result 配对建 run、重复 runId 原地更新（保持 startedAt/取最大 agent 数）、无 operation 裸 result 回退名、status 字符串映射、多 run 区分、subscribe/unsubscribe/clear/dispose 生命周期。
- [x] `subagent-activity-store.test.ts`（15 用例）——step 折叠+文本尾窗、tool call delta→started→result 组装、长 args 截断、错误标记+输出截断、live stdout/stderr 尾行、非 stdout/空文本忽略、retrying 元数据、step 数上限（totalSteps 单调）、完成/失败/恢复（version 递增）、跨记录驱逐（仅 terminal，running 不驱逐）、clear/drop、无 spawn 事件合成记录。
- [x] `btw-panel-spread.test.ts` 扩展行为语义（+14 用例）——空闲 sendUserInput 提交 session.prompt、面板关闭时 sendUserInput/closeOrCancel/scroll/routeEvent 返回 false、无 session submit 置 failed、prompt 拒绝置 failed（含错误信息）、closeOrCancel/cancelRunning/clear 取消路由、scroll down@0 no-op、turn.ended cancelled/blocked/error 状态映射、dispose 解绑 bus。
- [x] `tasks-browser-refresh.test.ts` 扩展行为语义（+13 用例）——show() 无 session 报错、初始选择 running 任务、已开 no-op、toggleFilter 循环、select 同任务不重载 tail、refresh 闪横幅、stop 调 session+刷新/无 session 闪提示、openOutput 取输出+附 viewer/无 session/已开 no-op、loadTail 解析填充 tailOutput、close 关闭 viewer+释放 slot。
- [x] **实证发现（2026-08-21）**：真实 store 的 `setState(key, object)`/`patch` 是 **SolidJS `mergeStoreNode` 原地合并**——切片引用稳定、保留兄弟字段（`state.tsx` patch 的 `{ ...slice, ...partial }` 经 mergeStoreNode 逐字段写入原对象）。因此 `loadTail` 的 `current !== browser`、`refreshList` 的同一守卫在真实 store 下均正常；tasks-browser 测试的 mock store 曾用"替换引用"实现，与真实语义不符导致新测试误报，已改为 `Object.assign` 原地合并忠实镜像。
- [x] `subagent-event-handler.test.ts`（19 用例）——routeChildAgentEvent：lifecycle/main 事件返回 false、tee 进 activityStore、assistant 累积进父 tool 条目、tool call started/delta/result 组装、agent.status.updated 记录 model+metrics、未知 subagent 吞掉；handleLifecycleEvent：前台 spawn 记忆+激活条目、后台 spawn 记 metadata+转录 started+同步 badge、后台 completed/failed 转录终态（含 applyBackgroundTaskTerminalStatus）、前台 completed 追加 resultSummary；swarm：started 发布 running、用户中止 result 置 ended、markActiveAgentSwarmsCancelled 只设标志不结束；reset 清理、dropForegroundOnlyActivityRecords 保留后台任务记录。
- [x] **发现的移植缺口（记录，未改产品行为）**：`subagent-event-handler.ts` 的 `markActiveAgentSwarmsCancelled` 只设内部 `cancelled` 标志，但 `agentSwarmData.status` 联合类型只有 `'streaming' | 'running' | 'ended'`——cancelled 是**只写状态**，且 tui2 树中 `agentSwarmData` 目前**无任何渲染方消费**（`components/messages/agent-swarm-progress.ts` 只是结果解析层）。v1 里 `markActiveAgentSwarmsCancelled` 调组件 `markActiveCancelled()` 会改变可见渲染。swarm 的取消/进度渲染集成是阶段 D 的残余缺口，待后续单独处理。
- [x] `plugin-update-notifier.test.ts`（17 用例）——`isPluginMcpToolName` 前缀判定；`handleMcpToolCompleted`：非 MCP 工具不碰 RPC、plugin 工具经 MCP server runtime 名解析出插件 id 并通知、miss 后刷新一次 server map、未解析工具静默吞掉；`checkAndNotify` 守卫：无 session/非官方目录/目录无该插件/未安装/本地 fork/已是最新/目录加载失败全部不通知；一次性语义：通知后持久化已通知版本、同版本不重复、新版本重通知、并发入队串行化（两插件都通知）。**测试暴露 harness 缺陷**：`listMcpServers` mock 曾返回 `string[]` 而非 `{ name: string }[]`，导致 `server.name` 为 undefined、regex 不匹配、map 为空——已修正。
- [x] `session-replay.test.ts`（13 用例）——`hydrateFromReplay`：main agent 缺失/抛异常 → showError+false、user/assistant/tool call/tool result 全链路渲染、isReplaying 包裹整个 hydration、plan_updated/permission_updated/goal_updated(created) 状态/目标条目、skill activation 渲染+去重、shell command 输入渲染 `$ cmd`；快照水合：todo 列表、全 done 清空、background 任务/metadata/counts 水合、terminal 后台 agent 状态应用。**测试中确认两个约定**：`Message.toolCalls` 是必需字段（assistant 文本记录需带 `toolCalls: []`，渲染器不做防御）；`renderedSkillActivationIds`/`renderedPluginCommandActivationIds` 在 `SessionEventHandler` 层而非 `subAgentEventHandler` 层。
- [x] `auth-flow.test.ts`（25 用例）——`refreshAvailableModels`：reload 后写 models/providers；`enterLoginRequiredStartupState`：reset runtime + 清 session 态 + OAuth 启动提示 + ready；`activateModelAfterLogin`：有 session 直接 setModel/setThinking（v1/v2 都不建会话）、无 session+v2 只配 model（lazySessionThinking 携带 effort）、无 session+v1 建会话（workDir/model/thinking/permission 三元 auto/yolo/undefined/planMode 来自 store 态/agentProfile/agentFiles 空数组省略/additionalDirs 透传），建会话后 setSession+syncRuntimeState+startSubscription+fetchSessions+updateTerminalTitle+refresh 命令；`clearActiveSessionAfterLogout`：closeSession('logged out')+清态+刷新命令；`refreshConfigAfterLogin`：无默认模型/模型缺失 → session-less v2 hydrate、默认模型命中 → activateModelAfterLogin(defaultModel, thinkingEffortFromConfig)（含 disabled → 'off'）、session-less v2 再 hydrate+写列表；`refreshConfigAfterLogout`：清 model 态；`refreshProviderModels`/`refreshOAuthProviderModels`：scope 透传、changed 非空才 refreshAvailableModels；**refresh persistence host**：legacy 直连 harness、atomic 主机 setConfig 先于 getConfig 抛错、removeProvider 内存暂存 + setConfig 一次 replaceConfigSections 原子写完整记录、OAuth token 经 harness auth 解析。**harness 语义**：`setSession` 真实变更 host.session 引用（模拟运行时登录后会话切换）；显式 `session: undefined` 与缺省区分（`??` 会把 undefined 回退成默认 session，需 `'session' in options` 判别）。
- [x] `session-event-handler.test.ts`（40 用例）——**事件路由**：带 turnId 事件 setTurnId、子代理事件 tee 进 activity store 后吞掉；**turn 生命周期**：started 重置工具 UI+step0+waiting pane+noteSessionTurnStarted、ended cancelled 标记 swarm 取消+finalizeTurn+记录活动、blocked/failed provider.filtered 状态、全 done 清 todo；**step 生命周期**：started 设 step+waiting、completed 上报 usage/cache/timing、max_tokens 截断提示（非 Anthropic 无 hint）、filtered 策略提示、interrupted aborted 提示、retrying 记 backoff 态；**流式增量**：thinking.delta 进 thinking+outputTokens（ASCII≈4/token、非 ASCII≈1/token 启发式，'reasoning…'→4）、空 delta 不切 phase、assistant.delta 先 flush thinking draft 再 composing；**工具调用**：started 注册工具+tool pane、delta 累积+composing、result 完成+计时+回 waiting、TodoList 清洗；**compaction**：started/结束（记活动）/取消（不记）；**后台任务**：agent started 标 backgrounded+repaint、process started 加状态条目、terminal agent 应用状态+活动记录标记 failed、**skill/plugin activation** 追加+去重；**error/warning**：OAuth code 专用提示、error 带 session 报 hint、warning 标色；**session meta/status**：标题+终端标题、contextUsage 计算、离开 task swarm 模式渲染 ended marker；**MCP 状态**：connected/failed 追加彩色状态行+去重；**goal.updated**：completion 追加确定性条目、lifecycle 追加 goal marker；**resetRuntimeState** 清全部。**harness 关键约定**：真实事件都带 `agentId: 'main'`，`routeChildAgentEvent` 对无 agentId 事件返回 true（tee 后吞掉）→ handle 辅助统一注入 main id，子代理事件用显式 child id 覆盖。
- [x] **修复 tui2 首屏内容缺失（2026-08-21）**：捕获真实渲染帧发现内容区（1-17 行）全空、只有编辑器+footer。根因四个：(1) `kind: 'welcome'` 条目从未被添加（v1 由 `renderWelcome()` 添加），且 main-shell 的 `welcome` 分支被错误渲染成 `PlanBoxView` 而非 `WelcomeView`——controller 新增 `renderWelcome()`（`initMainTui` + `clearTranscriptAndRedraw` 中调用，置顶且幂等），main-shell `welcome` 分支改渲染 `WelcomeEntryView`（从 store 读 model/workDir/sessionId/version/mcpServersSummary，与 v1 `WelcomeComponent` 读 appState 对应）；(2) `loadBanner()` 是空实现 → 用 `BannerProvider` + `readBannerDisplayState`/`writeBannerDisplayState` 真实加载写 `store.banner`；(3) `tui.dialogs.editor.label/navHint/placeholder` 三个 key 缺失 → 编辑器显示原始 key，已补 en/zh 语言包并重新生成 JSON；(4) agent pane 初始 `agentPaneItems` 为空时 main-shell 用 `length > 0` 门控隐藏，而 v1 始终渲染（空显示 "No agents"）→ 去掉门控。另外 run.tsx 的 Shell 把 termSize 硬编码成 80x24 → 改用 `@opentui/solid` 的 `useTerminalDimensions()`（跟随真实终端尺寸与 resize）。typecheck:tui2 + 全量 typecheck + 287 用例 + lint 0 error 全绿。

## 四、已确认的技术事实（不再重复探索）

1. **opentui 渲染只在 Bun 下可行**：Node 24 缺 `node:ffi`，opentui 的 node 后端唯一依赖它。
2. **`#/*` imports**：Node 生态（tsc/tsdown）通过 package.json imports + `moduleResolution: bundler` 解析，无需 paths；**只有 Bun 需要 tsconfig paths**。给包加 `"#/*": ["./src/*"]` 实测不破坏 tsc。注意 `#/*` 映射到 `./src/*.ts`（单文件），目录级 `#/tui2/theme` 不可用，tui2 内对 theme 用相对路径。
3. **交互循环已验证**：`createCliRenderer` + `render` + `useKeyboard` 在 Bun 真实终端跑通（`TUI2_SKELETON_BOOT_OK`）。
4. **controllers 是主要迁移面**：14 个 controllers 已从 pi-tui 命令式改为响应式 store 驱动。
5. **typecheck:tui2 与 lint 现状**：`tsc -p tsconfig.tui2.json --noEmit` 通过；lint 仅 warn 级 `no-non-null-assertion`（v1/tui2 一致，CI 用 `--quiet` 不受影响）。

## 五、决策点（一次性列出，后续推进不再重复问）

1. **运行时分发**（阶段 E 前必须定）：
   - 选项 A：tui2 作为 **Bun 打包**的分发产物（bun build --compile 单二进制），与 Node SEA 并存
   - 选项 B：tui2 只做 Bun 开发/验证，生产仍走 Node SEA（即 tui2 跑不了渲染）
   - 默认建议：A，但这是产品级决策，需要你确认
2. **验证方式**：交互必须真实终端验证（mock 环境键盘驱动不了）。骨架用 `KIMI_TUI2_BOOT_CHECK` 自动退出供 CI；真实交互由你运行 `bun src/tui2/demo-interactive.tsx` 确认。
3. **v1 引用清理顺序**：待办 1 优先（自包含完整性），再做待办 2（pi-tui 纯净度）。

## 六、推进原则

- **不中途打断**：按待办 1→2→3→4 连续推进，只在阶段 E（构建链）前必须确认分发方式时停下。
- **每个文件**：typecheck + lint + 能启动验证。
- **提交**：每完成一个可验证批次，提交 + push（遵循仓库规范，内部架构不写 changeset）。