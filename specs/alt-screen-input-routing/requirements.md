# Requirements — 全屏（alternate screen）交互模块的输入路由与恢复

本 spec 记录 2026-10 全屏交互模块审计后**必须修完**的六项缺陷。每一项都有可复现的证据行号，
不包含"观察项"或"后续再看"。

## 目标

让全屏模式下**焦点组件仍然拥有自己的按键**，并让三条恢复路径（退出、应急、resize 后的上限）
与常规模式共享同一套事实。

## 受众

维护 `packages/pi-tui`（渲染器）与 `apps/kimi-code/src/tui`（应用层装配）的开发者。
读这份文档是为了知道：改哪个符号、为什么现在不对、改完用哪条断言证明。

## 背景事实（审计结论，均已复现）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `handleViewportInput` 在 `primaryScrollable` 为真时**无条件**消费 `pageUp/pageDown/home/end`，只让位于 overlay | `packages/pi-tui/src/tui-alt-screen.ts:800-849`、`:711-713` |
| F2 | transcript 一旦可滚动，聚焦的编辑器收不到 `Home`/`End`：光标不动，视口 0↔91 跳 | 探针复现（见 design.md「复现」） |
| F3 | 应用侧 dock 对话框（help / tasks-browser / trust-prompt / provider-manager / searchable-list / approval-preview）都用 `PageUp/PageDown/Home/End` 自己翻页，全屏下全部失效 | `help-panel.ts:89-93`、`tasks-browser.ts:249-261`、`trust-prompt.ts:56-57`、`provider-manager.ts:306-312`、`searchable-list.ts:125-129`、`approval-preview.ts:95-107` |
| F4 | `Ctrl-Shift-F`（search）在 defer 闸**之前**判断，占满全屏的 takeover 视图里按它仍会弹搜索框并抢焦点 | `tui-alt-screen.ts:781-784` vs `:799` |
| F5 | 常规模式 `buildLayout` 挂的是 `todoPanelContainer`/`notifyPanelContainer`，二者全项目**从未被 addChild**；真正持有 `statusSurface` 的是 `statusSurfaceContainer` | `kimi-tui.ts:1290-1291`；`tui-state.ts:206,243`（唯一挂载点） |
| F6 | `git show f4bb860b0f` 把 `ui.addChild(statusSurfaceContainer)` 换成了上述两行；`stopUiForExit` 同步被改坏 | `kimi-tui.ts:1332-1333` |
| F7 | 常规模式下 todo/updates/approval 整条 strip 不渲染，但审批仍 `focusRegion('approval')` 并阻塞提交 | `dialog-host.ts:333-334`、`resolve.ts:230` |
| F8 | `restoreTerminalModes()` 的应急序列缺 `?1004l`，而全屏开了 `?1004h` | `terminal-restore.ts:21-23` vs `tui-alt-screen.ts:66-67` |
| F9 | 选中即复制的 `copySelection` 未注入，退化为裸 OSC 52 且照样 flash "Copied!"；应用已有 verified 通路 | `tui-state.ts:147-169`、`tui-alt-screen.ts:1608-1621`、`commands/copy.ts:34` |
| F10 | dock 的 `maxSize` 在构造时快照 `terminal.rows * 0.5`，其余面板都是活取值 | `tui-state.ts:251-255` vs `:181,184,194` |
| F11 | `tui.altScreen.halfPageUp/halfPageDown/lineUp/lineDown` 四个 id 是 `defaultKeys: []`，应用从不 `setKeybindings` | `keybindings.ts:168-183`；全仓无 `setKeybindings` 调用 |

## 范围

### 纳入（六项，全部要修完）

1. **R1 视口按键让行**：`TuiAltScreen` 只在"焦点组件不想要这个键"时消费视口导航键。
2. **R2 搜索热键归位**：`Ctrl-Shift-F` 在 takeover / 对话框持焦时同样让行。
3. **R3 status surface 重新挂载**：常规模式与退出回放都挂 `statusSurfaceContainer`。
4. **R4 应急恢复补 `?1004l`**：崩溃路径不再把 shell 留在 focus-reporting 状态。
5. **R5 复制走 verified 通路**：注入 `copySelection`，成功/失败如实反馈。
6. **R6 dock 上限活取值**：`maxSize` 改成 `() => number` 或等价的每帧求值。

### 明确排除（不在本轮，理由）

- **`TuiAltScreen` 的形参语义改造**（把 `options` 收进构造对象）：属于 API 重构，不修缺陷，
  违反"不夹带清单外重构"。R5 只在既有 options 形状内加一个字段。
- **四个空绑定（F11）补默认键**：这是产品决策（哪些键该归视口），不是缺陷；且补默认键会扩大
  R1 刚收窄的遮蔽面。留待有人明确要这组能力时再做。
- **`approvalPreview` 在 shutdown 时未 fold（审计 F7）**：影响范围是"退出瞬间的最后一帧内容"，
  与本次六项的输入路由无关，单独一轮处理以免混淆验证。
- **`backgroundTasksMini` 用 `any` 操作 `Stack.entries`（审计 F8）**：不改变可观察行为，
  是类型质量债；不在本轮。
- **`?1004l` 之外的其他应急序列顺带整理**：只补缺失的这一个，不改其余顺序。
