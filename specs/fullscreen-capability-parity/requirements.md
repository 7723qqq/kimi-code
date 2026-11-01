# Requirements — 全屏（alternate screen）模式的能力覆盖与对齐

本 spec 记录 2026-10 全屏模式能力盘点后的**待修项**。每一项都有可复现的证据行号；
不包含"观察项"或"后续再看"。

上一份 spec（[`alt-screen-input-routing`](../alt-screen-input-routing/)）修的是**输入路由**
（谁先看到按键）。本 spec 修的是**能力覆盖**：同一批面板、对话框、交互方式，在常规模式
能用的，在全屏模式下是否还能用。

## 目标

让全屏模式覆盖常规模式**已有**的 TUI 能力：常规模式能翻页的面板，在全屏模式下也能翻页；
两种模式对同一个按键的归属一致。差异只保留在全屏模式**特有**的能力上（应用内滚动、
应用内选区、会话记录搜索……），并把这份差异写进文档。

## 受众

维护 `packages/pi-tui`（渲染器）与 `apps/kimi-code/src/tui`（应用层装配）的开发者。
读这份文档是为了知道：矩阵里哪一格缺、缺在哪一行、改完用哪条断言证明。

## 模式开关链路（已核对，无缺口）

| 能力 | 证据 |
| --- | --- |
| `tui.toml` 的 `tui_mode = "regular" \| "fullscreen"` | `apps/kimi-code/src/tui/config.ts:70-71`、`:309-320` |
| 旧环境变量 `KIMI_CODE_TUI_FULL_SCREEN=1` 的迁移 | `apps/kimi-code/src/tui/config.ts:23-24`、`:193-197`、`:213-218` |
| `/settings` 的 TUI mode 选择器 | `apps/kimi-code/src/tui/components/dialogs/tui-mode-selector.ts:27-38`、`apps/kimi-code/src/tui/commands/config.ts:1245-1258` |
| 选择后写回 `tui.toml` 并镜像 `appState` | `apps/kimi-code/src/tui/commands/config.ts:1270-1307` |
| 切换后提示需重启 | `apps/kimi-code/src/tui/constant/kimi-tui.ts:26-28`、`apps/kimi-code/src/tui/commands/config.ts:1304-1306` |
| `/reload` 发现模式与运行态不一致时提示重启 | `apps/kimi-code/src/tui/commands/reload.ts:93-95` |

## 覆盖矩阵

状态列四种取值：

- **一致** —— 两种模式都有，行为相同。
- **两模式行为不一致** —— 两种模式都有，但同一个按键/动作的归属不同。
- **全屏缺失** —— 常规模式有，全屏模式没有。
- **仅全屏可用** —— 全屏模式独有，常规模式没有（不是缺口，是差异）。

### A. 底部 chrome（常规模式的根子节点 / 全屏模式的 dock 行）

| 面板 | regular | fullscreen | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| 会话记录 | 根子节点（终端滚动缓冲） | dock 上方的 `ScrollView` | 仅全屏可用 | `kimi-tui.ts:1325`、`tui-state.ts:249,282` |
| 活动面板 activity | 根子节点 | dock 行（上限 6 行） | 一致 | `kimi-tui.ts:1326`、`tui-state.ts:264` |
| 状态条 status surface（统计 / 更新 / 审批） | 根子节点 | dock 行（上限 `STATUS_SURFACE_MAX_ROWS`） | 一致 | `kimi-tui.ts:1328`、`tui-state.ts:265-269` |
| 排队队列 queue | 根子节点 | dock 行（上限 8 行） | 一致 | `kimi-tui.ts:1329`、`tui-state.ts:270` |
| btw 面板 | 根子节点 | dock 行（上限 18 行） | 一致 | `kimi-tui.ts:1330`、`tui-state.ts:271` |
| 问卷 survey | 根子节点 | dock 行（上限 5 行） | 一致 | `kimi-tui.ts:1331`、`tui-state.ts:272` |
| 后台任务 mini | 根子节点 | dock 行（上限 = 终端行数 ÷ 2，每次布局求值） | 一致 | `kimi-tui.ts:1327`、`tui-state.ts:273-279` |
| 输入框 editor | 根子节点 | dock 行（下限 3 行：上边框 / 输入 / 下边框） | 一致 | `kimi-tui.ts:1332`、`tui-state.ts:280` |
| 页脚 footer | 根子节点 | dock 行（下限 1 行） | 一致 | `kimi-tui.ts:1341-1352` |

### B. 面板 / 对话框

| 面板 / 对话框 | 挂载方式 | regular | fullscreen | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 帮助 help | 编辑器槽位 | ✅ | ✅ | 一致 | `dialog-host.ts:157-170`、`help-panel.ts:80-81` |
| 会话选择器 session picker | 编辑器槽位 | ✅ | ⚠️ `PgUp`/`PgDn` 被视口抢走 | **两模式行为不一致** | `dialog-host.ts:250-296`、`session-picker.ts:277` |
| 选择器系列（主题 / 语言 / 模型 / 权限 / 编辑器 / Mermaid / 问卷 / 更新 / 平台 / 设置 / TUI mode / 插件确认 ×2） | 编辑器槽位 | ✅ `PgUp`/`PgDn` 翻页 | ❌ `PgUp`/`PgDn` 被视口抢走 | **全屏缺失** | `choice-picker.ts:126-127`、`searchable-list.ts:120-136` |
| 审批面板 approval | 状态条内联 | ✅ 正文完整 | ✅ 正文 6 行 + 滚轮 | 一致 | `dialog-host.ts:328-356`、`dock-section.ts:83-89` |
| 审批预览 approval preview | 接管 layout root / 根子节点 | ✅ | ✅ | 一致 | `dialog-host.ts:399-423` |
| 任务浏览器 tasks browser | 接管 layout root / 根子节点 | ✅ | ✅ | 一致 | `controllers/tasks-browser.ts:95,129` |
| 信任提示 trust prompt | 编辑器槽位 | ✅ | ✅ | 一致 | `kimi-tui.ts:4525-4536`、`trust-prompt.ts:35-36` |
| 供应商管理 provider manager | 编辑器槽位 | ✅ | ✅ | 一致 | `provider-manager.ts:226-227` |
| 问题对话框 question dialog | 编辑器槽位 | ✅ | ✅（输入框） | 一致（R1 后） | `dialog-host.ts:425-443` |
| 用量报告 usage | 追加到会话记录 | ✅ | ✅ | 一致 | `commands/info.ts:167-190` |
| 工具输出展开 `Ctrl-O` | 会话记录内 | ✅ | ✅ | 一致 | `editor-keyboard.ts:364-367` |

### C. 交互方式

| 交互 | regular | fullscreen | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| 会话记录滚动 | 终端原生滚动缓冲 | 应用内 `ScrollView` + 滚轮 | 仅全屏可用 | `tui-alt-screen.ts:1107-1121` |
| 鼠标选区 + verified 复制 | 终端原生 | 应用内选区 + 注入的 `copySelection` | 仅全屏可用 | `tui-alt-screen.ts:1464-1657`、`tui-state.ts:173-179` |
| **列表对话框的鼠标交互**（悬停高亮 / 滚轮翻页 / 点击选中） | 终端原生（终端接管鼠标，应用收不到事件） | ❌ 只有选择器系列（继承 `ChoicePickerComponent`）有；模型选择器、会话列表、供应商管理等一律点不动 | **全屏缺失** | `tui-alt-screen.ts:1134-1150`（应用接管鼠标）、`components/dialogs/choice-picker.ts`（唯一已有实现） |
| `Ctrl-Shift-F` 会话记录搜索 | ❌ | ✅ | 仅全屏可用 | `tui-alt-screen.ts:808-814` |
| `Ctrl-Up`/`Ctrl-Down` prompt 跳转（OSC 133 zone） | ❌ | ✅ | 仅全屏可用 | `tui-alt-screen.ts:870-877`、`constant/rendering.ts:4-11` |
| OSC 8 链接点击 | 终端原生 | 应用内 `openUrl` 接管 | 仅全屏可用 | `tui-alt-screen.ts:1482-1492`、`tui-state.ts:150` |
| Windows 右键粘贴 | 终端原生 | 应用内 bracketed paste | 仅全屏可用 | `tui-alt-screen.ts:1134-1150`、`tui-state.ts:155-166` |
| 粘性用户消息摘要条 | ❌（滚动缓冲保留原文） | ✅ | 仅全屏可用 | `components/messages/transcript-view.ts:10-11,47`、`utils/sticky-user-message.ts:39` |
| 跟随底部指示器 | ❌ | ✅ | 仅全屏可用 | `tui-alt-screen.ts:1826-1850`、`tui-state.ts:169` |
| 编辑器 `Home`/`End` 移动光标 | ✅ | ✅ | 一致 | `custom-editor.ts:155`、`tui-alt-screen.ts:835-885` |
| 状态条 `PgUp`/`PgDn` 翻页 | ✅ | ✅ | 一致 | `custom-editor.ts:630-638`、`statusSurfaceKeyOf` `custom-editor.ts:991-1004` |
| 状态条 `[`/`]` 别名 | ✅ | ✅ | 一致 | `custom-editor.ts:996-997` |
| **面板自身的 `PgUp`/`PgDn` 翻页** | ✅ | ❌ | **全屏缺失** | `searchable-list.ts:129-136` vs `tui-alt-screen.ts:836-869` |
| 退出后回放到终端滚动缓冲 | ✅（原生） | ✅（`stopUiForExit` 重放） | 一致 | `kimi-tui.ts:1358-1381` |
| 外部编辑器时 `preserveScreen` | n/a | ✅ | 一致 | `editor-keyboard.ts:869` |
| 应急恢复 `?1004l` | ✅ | ✅ | 一致 | `utils/terminal-restore.ts:24-26` |

## 范围

### 纳入（三项，全部要修完）

1. **R1 面板自己翻页的键不再被视口抢走**：编辑器槽位里的模态面板声明拥有视口导航键，
   `PgUp`/`PgDn`/`Home`/`End` 到达面板而不是会话记录视口。实现落在应用侧唯一的
   "用面板替换编辑器"入口 `DialogHostController.mountEditorReplacement()`
   （`apps/kimi-code/src/tui/controllers/dialog-host.ts:114`）——约 50 个调用点都经过它，
   一次覆盖全部面板。
   状态条内联的审批面板**不需要**这项：它的翻页走的是"编辑器 → `statusSurfaceKeyOf`
   → 状态条 → 聚焦区"这条与模式无关的通路，两种模式本来就一致。
2. **R2 状态条与面板的按键归属文档化**：`keyboard.md` 里"全屏模式下 `PgUp`/`PgDn` 用于
   翻动会话记录"的说法与实现不符（编辑器已经把这两个键交给状态条），改成实际行为。
3. **R3 `tui_mode` 的覆盖范围文档化**：`config-files.md` 的 `tui_mode` 描述与
   `tui_mode-selector` 的说明反映矩阵里的实际覆盖面。
4. **R4 列表对话框的鼠标交互**：全屏模式下应用接管鼠标，面板不回答鼠标事件就等于
   点不动。共享一套路由（悬停高亮该行、滚轮翻页、点击选中），让所有列表对话框
   与选择器系列行为一致；只会滚动、不用选择的面板（帮助面板）走"只滚轮"的那条路。
   同一轮补齐两类特殊形状：**标签条**（点击按列命中，切换标签）与**带状态的问答面板**
   （问题对话框：选项行、题目标签、提交动作三处都可点，点击语义与键盘一致）。
   行点击只做"选中"，删除/开关/安装这类动作仍由键盘触发，避免歧义点击造成破坏。

### 明确排除（不在本轮，理由）

- **把编辑器槽位的面板改成全屏接管（takeover）**：全屏模式下这类面板会占满 dock、
  把会话记录挤到 1–2 行；常规模式下它们只是接在滚动缓冲下面。这是**布局差异**，
  不是能力缺失——面板本身完全可用，会话记录也仍可用滚轮翻。要改成接管就是重做
  dock 布局模型，超出"补齐覆盖范围"。
- **在模态面板之上禁用 `Ctrl-Shift-F`**：会话记录搜索是全屏**独有**能力，压掉它是减能力
  而不是补能力。现有实现只对 takeover 级只读视图禁用（`approval-preview`、
  `tasks-browser`、`trust-prompt`、`help-panel`、`provider-manager`），保持不变。
- **`tui.altScreen.pageUp`/`pageDown` 变成不可达**：应用侧焦点组件（编辑器、面板）
  都声明了拥有视口键，这两个绑定因此没有应用内使用者。它是 pi-tui 层的能力，
  留给第三方宿主；不为它改应用语义。
- **`previousPrompt`/`nextPrompt` 也随面板让行**：这两个是全屏阅读器专属语义，
  上一份 spec 已明确判定不随焦点组件让行（`tui-alt-screen.ts:870-877`）。
- **`tui.altScreen.halfPageUp`/`halfPageDown`/`lineUp`/`lineDown` 补默认键**：产品决策，
  且会让 R1 刚收窄的遮蔽面重新变大。
