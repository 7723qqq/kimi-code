# Design — 全屏输入路由与恢复

需求见 `requirements.md`（R1–R6 与排除项）。本文件写"怎么改、为什么这样改、复现与验证"。

## 复现（改之前的事实）

以下都在改代码前用一次性探针跑出来，探针已删除。仓库里没有留下探针文件。

**R1/R2 复现**：`TuiAltScreen` + `VStack[transcript(grow:1), dock[Editor]]`，
transcript 分别 2 行 / 100 行，聚焦编辑器，发 `Home`→`End`：

```
[transcript fits    ] Home → 光标 8→0   End → 0→8    （正确）
[transcript scrolls ] Home → 光标不动   End → 不动    （scrollTop 0↔91 跳）
```

改完后同一探针对照：

```
[transcript fits    ] Home → 光标 8→0   End → 0→8    （不变）
[transcript scrolls ] Home → 光标 8→0   End → 0→8    （已修）
```

dock 换成应用真实的 `HelpPanelComponent`，transcript 200 行：

```
[transcript CAN scroll] PageDown → 面板没动，scrollTop 180→199
```

即"对话框在屏幕上、按键却去滚 transcript"。

**R3 复现**：按 `kimi-tui.ts:1281-1297` 的 `buildLayout` 等价代码装配常规模式根节点，
9 个子节点里没有 `statusSurfaceContainer`，`ui.render(80)` 不含 strip 内容。

## R1 — 视口按键让行

### 现状机制

`TuiBase.handleTerminalInput`（`packages/pi-tui/src/tui.ts:1207-1222`）先跑 input listener，
任一返回 `{consume:true}` 即终止；`TuiAltScreen` 在构造函数（`tui-alt-screen.ts:284`）把
`handleViewportInput` 注册为 listener，所以它**抢在**焦点组件之前看到每一个键。

`Component` 已有 `wantsKeyRelease?: boolean`（`tui.ts:148-152`）这个"组件向宿主声明诉求"的先例，
R1 沿用同一形状：**不是新机制，是把已有先例用在键盘上**。

### 改动

在 `Component` 接口加一个可选声明：

```ts
/** If true, the host must not consume navigation keys that this component handles itself. */
ownsViewportKeys?: boolean;
```

`TuiAltScreen` 增加一个判定：

```ts
private focusedComponentOwnsViewportKeys(): boolean {
  const focused = this.getFocusedComponent();
  return focused !== null && focused.ownsViewportKeys === true;
}
```

`handleViewportInput` 中，**视口导航键那一段**（`tui-alt-screen.ts:800-849`）的入口改为按绑定分别判定：

```ts
const focusedOwnsNavigation = this.focusedComponentOwnsViewportKeys();
// pageUp / pageDown / halfPageUp / halfPageDown / lineUp / lineDown / top / bottom
if (!focusedOwnsNavigation && primaryScrollable && keybindings.matches(data, 'tui.altScreen.pageUp')) { … }
```

位置必须在 search 键判断（`:781-798`）**之后**、`pageUp` 判断（`:800`）**之前**。

### 让行范围：只含未修饰的导航键

执行时发现：把整段 800-849 一起拦掉会连带挡掉 `previousPrompt`/`nextPrompt`
（`Ctrl-Shift-Up/Down`）。这两个是全屏阅读器**专属**的语义跳转，编辑器与 dock 对话框都不绑定它们，
让行等于凭空砍掉一个既有能力（`fullscreen-layout.test.ts` 的 Ctrl-Shift-Up/Down 用例当场变红）。

因此让行只覆盖**未修饰**的键：`pageUp`、`pageDown`、`halfPageUp`、`halfPageDown`、
`lineUp`、`lineDown`、`top`(Home)、`bottom`(End)。
`previousPrompt`/`nextPrompt` 保持在视口手里，不做条件判断。

`primaryScrollable` 的门保持不变：不可滚动时这套逻辑本就整体让行（既有用例 `:968`）。

### 谁声明

| 组件 | 文件 | 声明理由 |
| --- | --- | --- |
| `CustomEditor` | `apps/kimi-code/src/tui/components/editor/custom-editor.ts` | 编辑器自己要 `Home`/`End` 移动光标；`PageUp/PageDown` 已在 `statusSurfaceKeyOf` 里接管 |
| `HelpPanelComponent` | `components/dialogs/help-panel.ts` | 自带 `scrollTop` + `:89-93` 翻页 |
| `ApprovalPreviewViewer` | `components/dialogs/approval-preview.ts` | 自带 `scrollTop` + `:95-107` |
| `TasksBrowserComponent` | `components/dialogs/tasks-browser.ts` | `:249-261` |
| `TrustPromptComponent` | `components/dialogs/trust-prompt.ts` | `:56-57` |
| `ProviderManagerComponent` | `components/dialogs/provider-manager.ts` | `:306-312` |
| `SearchableList` 的宿主 | `utils/searchable-list.ts` | `:125-129` |

`SearchableList` 不是 `Component`，它被对话框包着；只要包它的对话框声明即可，
不在 `SearchableList` 上加字段。

### 为什么不改成"视口先问组件"

那需要给 `Component` 加 `handleInput` 的返回值约定，会改动 `handleInput(data: string): void`
这个被全仓大量实现的签名。`ownsViewportKeys` 是布尔声明，零签名迁移。

## R2 — 搜索热键归位

`tui-alt-screen.ts:781-784` 当前无条件处理 `tui.altScreen.search`。改为与 R1 同一个判定：

```ts
if (keybindings.matches(data, 'tui.altScreen.search')) {
  if (!this.focusedComponentOwnsViewportKeys()) {
    if (!isRelease) this.toggleSearch();
    return { consume: true };
  }
}
```

即：组件声明自己拥有视口键时，搜索热键也归它。这不改变"编辑器持焦时 Ctrl-Shift-F 打开搜索"
这一现状（编辑器不声明 `ownsViewportKeys` 覆盖搜索——见下）。

**契约**：`ownsViewportKeys` 只让行**导航键**（R1）与**搜索热键**（R2）；
它不让行 `searchNext/searchPrevious/searchClose`，那三个只在搜索 overlay 自己聚焦时生效
（`:785-798`），走的是 `isOverlayFocused` 分支，与本次改动不交叉。

为保持"编辑器持焦时搜索仍可用"，`CustomEditor` **不**声明用 R2 的搜索让行——
即 `ownsViewportKeys` 语义拆成两个独立可选字段不划算（一个字段两个用途会被误读），
所以采用：

```ts
ownsViewportKeys?: boolean;        // pageUp/pageDown/home/end 等导航键
ownsViewportSearchKey?: boolean;   // Ctrl-Shift-F
```

`CustomEditor` 只设 `ownsViewportKeys: true`；takeover 级视图（help / approval-preview /
tasks-browser / trust-prompt）两个都设。这样"编辑器按 Ctrl-Shift-F 仍开搜索"被保留，
"在只读预览里按 Ctrl-Shift-F 不该弹搜索抢焦点"被修掉。

## R3 — status surface 重新挂载

`kimi-tui.ts:1290-1291` 与 `:1332-1333` 两处，把

```ts
ui.addChild(this.state.todoPanelContainer);
ui.addChild(this.state.notifyPanelContainer);
```

换回单个

```ts
ui.addChild(this.state.statusSurfaceContainer);
```

同时删除 `tui-state.ts` 里已经无消费者的 `todoPanelContainer` / `notifyPanelContainer` 字段吗？
**不删。** 它们仍被 `:3541`（`todoPanelContainer.clear()`）和 `tui-state.ts:180,182` 使用，
且删除属于清单外重构。本轮只修正挂载点，字段保留。

`backgroundTasksMiniContainer` 在常规模式的 `:1289` 挂载保持不变——它是独立面板，
不归 strip 管。

### 为什么 R3 必须排在 R1 之前验证

R3 影响的是"strip 是否渲染"，R1 影响"按键去哪"。两者无依赖，但 R3 会改变常规模式
`ui.children` 的形状，若与 R1 同时改，回归定位会混在一起。tasks.md 里 R3 排第一。

## R4 — 应急恢复补 `?1004l`

`terminal-restore.ts:21-23` 的序列按"关掉所有全屏打开的东西"排列。全屏开的是
`?1000h ?1002h ?1003h ?1004h ?1006h`（`tui-alt-screen.ts:66-67`），关的是
`?1006l ?1004l ?1003l ?1002l ?1000l`（`:68`）。应急序列当前有 1000/1002/1003/1006，
缺 1004。补在 1006 之后、`?7h` 之前，与 pi 的关闭顺序一致（倒序关闭）。

## R5 — 复制走 verified 通路

`TuiAltScreenOptions.copySelection?: (text: string) => Promise<boolean>` 已存在
（`tui-alt-screen.ts:189-193`），只是应用没传。在 `tui-state.ts:147-169` 的 options 里加：

```ts
copySelection: async (text) => {
  try {
    const method = await copyTextToClipboard(text);
    return method === 'native';
  } catch {
    return false;
  }
},
```

`copyTextToClipboard` 返回 `'native' | 'osc52'`（`utils/clipboard/clipboard-text.ts:110-112`）。
只有 `'native'` 算成功——这正是 `commands/copy.ts:34` 与 `session.ts:78` 已有的判定方式。
`TuiAltScreen.copyTextToClipboard`（`:1608-1621`）在 `copySelection` 存在时已经会
`flash(ok ? 'Copied!' : 'Copy failed')`，所以 OSC 52-only 的终端会看到 `Copy failed`
而不是假的 `Copied!`——这是修掉"谎报成功"，不是新增文案。

**用户可见文案**：`'Copied!'` / `'Copy failed'` 是 pi-tui 里的英文字面量（`tui-alt-screen.ts:1615,1619`），
不是 `apps/kimi-code` 的 locale 键。pi-tui 没有 i18n 层，且这两个字符串在改动前后不变，
所以本轮**不新增 locale 键、不改文案**，locale 门禁不受影响。

## R6 — dock 上限活取值

`tui-state.ts:251-255`：

```ts
dockContainer.addChild(backgroundTasksMiniContainer, {
  shrink: 1,
  minSize: 0,
  maxSize: Math.floor(terminal.rows * 0.5),
});
```

`allocateStackSizes`（`packages/pi-tui/src/components/stack.ts:148-166`）在**每次布局**时读
`entry.maxSize`，所以只要让这个值在每次布局时求值即可。`StackLayoutEntry.maxSize` 当前是
`number`（`layout-node.ts:16`）。改成 `number | (() => number)` 会波及
`clampSize`/`distribute`/`Stack.addChild` 三处读取点，是 pi-tui 的对外类型变更。

**更小的改动**：在应用侧用 `visible` 回调已经拿到的 `viewport` 参数做不到（`maxSize` 与
`visible` 是不同字段）。所以本轮采用 pi-tui 允许的最小扩展：

```ts
// layout-node.ts
maxSize?: number | (() => number);
```

读取点统一走一个 `resolveMaxSize(entry)` 帮助函数，三处替换。`number` 保持兼容，
已有调用方零改动。

### 为什么不改成"每帧重建 dock 条目"

重建会 `removeChild`/`addChild`，丢 `Stack.entries` 顺序且触发 `requestRender(true)` 全量重绘，
代价远大于一个 getter。

## 依赖关系

```
R3 (独立, 先做: 改变常规模式 ui.children 形状)
  ↓ 无逻辑依赖，只影响回归定位
R1 (pi-tui 接口扩展) ──→ R2 (复用 R1 的判定)
  ↓
  组件声明 ownsViewportKeys (app 侧, 依赖 R1 的字段存在)
R4 (独立)
R5 (独立)
R6 (依赖 pi-tui 的 maxSize 类型扩展)
```

R1 必须早于"组件声明"任务：字段不存在时 app 侧声明无法编译。
R2 必须晚于 R1：复用同一个判定函数。
R6 的 pi-tui 类型扩展必须早于 `tui-state.ts` 传 getter。

## 验证

每个任务的验收断言写在 `tasks.md`，全部是可 `bun test` 真实失败/通过的断言。

- `packages/pi-tui` 与 `apps/kimi-code` 各跑受影响的测试文件 + 包级 `bun run test`。
- R1/R2/R6 改了 `packages/pi-tui` 的对外类型（`Component`、`StackLayoutEntry`），
  属于"被别的包消费的导出类型"，按 CONVENTIONS 的 scope ladder 升到根 `bun run test`。
- `bun run check:no-comments` 必须绿（改动不碰三个禁注释区，但要证明没碰）。
- locale 门禁：本轮不新增用户可见文案，仍跑一次 `check-t-call-coverage` 作为证据。
