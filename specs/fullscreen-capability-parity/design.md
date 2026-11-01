# Design — 全屏模式的能力覆盖与对齐

需求见 `requirements.md`（R1–R3 与排除项）。本文件写"怎么改、为什么这样改、怎么证明"。

## 复现（改之前的事实）

以下都在改代码前用一次性探针跑出来，探针已删除，仓库里没有留下探针文件。

**核心复现（R1）**：`TuiAltScreen` + 长会话记录 + 编辑器槽位里的 `ChoicePickerComponent`
（40 个选项，`pageSize` 8），会话记录滚到顶部后发 `PgDn`：

```
regular   : PgDn → 选择器翻到 "option 8"                        ✅ 面板自己翻页
fullscreen: PgDn → viewportTop 0→3，选择器仍停在 "option 0"     ❌ 键被视口吃掉
```

即"会话记录能翻页时，面板翻不了页"。

**对照复现（状态条不是问题）**：全屏模式下编辑器持焦时发 `PgUp`，编辑器把它映射成
`statusSurfaceKeyOf` 的 `'pageUp'` 交给状态条（探针记录到 `["pageUp"]`），
`viewportTop` 不动。状态条与审批区的翻页在两种模式下**已经一致**——因为编辑器的
`ownsViewportKeys` 让渲染器先让行，键由编辑器转发给状态条。

## R1 — 模态面板保留自己的导航键

### 机制回顾

`TuiBase.handleTerminalInput`（`packages/pi-tui/src/tui.ts:1227-1242`）先跑 input listener，
任一返回 `{consume:true}` 即终止。`TuiAltScreen` 在构造函数
（`packages/pi-tui/src/tui-alt-screen.ts:289`）把 `handleViewportInput` 注册为 listener，
所以它**抢在**焦点组件之前看到每一个键。

`Component` 已有 `ownsViewportKeys?: boolean`（`packages/pi-tui/src/tui.ts:154-164`）这个
"组件向宿主声明诉求"的先例，R1 沿用同一形状：**不是新机制，是把已有先例用满**。

### 改动：一个入口，一行

应用侧唯一"用面板替换编辑器"的地方是
`DialogHostController.mountEditorReplacement()`（`apps/kimi-code/src/tui/controllers/dialog-host.ts:114`）。
所有以面板形态出现的对话框都经过它——`/settings` 的各个选择器、`/sessions` 会话选择器、
`/provider` 供应商表单、`/plugins` 插件面板、`/goal` 队列管理、`/undo` 撤销选择、
`/swarm`、`/hello-world`、`/add-dir`、`/import-sessions`、问题对话框、缓存提示、提示词优化，
以及 `kimi-tui.ts:4431` 与 `commands/dispatch.ts:138` 这两个转发点。

改动：

```ts
mountEditorReplacement(panel: Component & Focusable, onDisplaced?: () => void): void {
  ...
  // 编辑器槽位里的面板是模态的：在它被关掉之前，键盘归它。
  // 全屏渲染器是 input listener，会先于焦点组件看到每个键；没有这句声明，
  // 一个自己翻页的面板（选择器、会话列表）在会话记录可滚动时就会丢掉
  // PgUp/PgDn——常规模式下这些键是直接进面板的。
  panel.ownsViewportKeys = true;
  this.host.state.editorContainer.clear();
  this.host.state.editorContainer.addChild(panel);
  this.host.state.ui.setFocus(panel);
  ...
}
```

### 为什么选这个位置，而不是别的三处

| 备选 | 为什么不用 |
| --- | --- |
| 逐个面板声明 `ownsViewportKeys` | 13 个 `ChoicePickerComponent` 子类 + 8 个 `SearchableList` 宿主 = 20+ 处；以后新增面板还会漏 |
| 改 `Component.handleInput` 的返回类型 | 波及全仓大量实现；上一份 spec 已明确否决（`specs/alt-screen-input-routing/design.md`「为什么不改成"视口先问组件"」） |
| 在 pi-tui 里让焦点组件优先 | 同样的签名问题；而且"这个面板是否模态"是**应用层**的知识，pi-tui 不该猜 |

`ownsViewportKeys` 已经是 pi-tui 的既有机制，R1 不改 pi-tui 的任何一行。

### 已经显式声明的组件

`custom-editor`、`help-panel`、`approval-preview`、`provider-manager`、`tasks-browser`、
`trust-prompt` 六个组件已经声明了 `ownsViewportKeys`（见 `requirements.md` 矩阵 B）。
R1 之后这些声明**保留**：它们让组件自解释，也覆盖了"同一个组件被非编辑器槽位挂载"的可能。
`mountEditorReplacement` 的赋值对它们是幂等的。

### 取舍

全屏下面板持焦时，`PgUp`/`PgDn`/`Home`/`End` 归面板，不再翻会话记录视口。

- **与常规模式一致**：常规模式下面板拿不到这些键（终端只把键交给焦点组件），
  会话记录由终端滚动缓冲负责。
- **会话记录仍可翻**：鼠标滚轮（`tui-alt-screen.ts:1107-1121`）与
  `Ctrl-Up`/`Ctrl-Down` 的提问跳转（`tui-alt-screen.ts:870-877`）都不受影响。
- **`Ctrl-Shift-F` 不受影响**：面板不声明 `ownsViewportSearchKey`，会话记录搜索照常能开——
  它是全屏**独有能力**，压掉它是减能力而不是补能力。

### 不影响的东西

- `previousPrompt`/`nextPrompt`（`Ctrl-Up`/`Ctrl-Down`）在 `tui-alt-screen.ts:870-877`
  仍然无条件消费，与上一份 spec 的判定一致。
- 状态条与审批区的翻页路径（编辑器 → `statusSurfaceKeyOf` → 状态条 → 聚焦区）
  本来就与模式无关，R1 不碰。

## R2 — 文档：按键归属与 `tui_mode` 覆盖范围

### `keyboard.md`

`docs/zh/reference/keyboard.md:21` 与 `docs/en/reference/keyboard.md:21` 现在写：

> `PgUp` / `PgDn` 同样可以切换；**全屏模式下这两个键用于翻动会话记录**

这句与实现不符。探针证据：全屏模式下编辑器持焦时 `PgUp` 被编辑器映射成 `'pageUp'`
交给状态条（`custom-editor.ts:630-638`），`viewportTop` 不动；两个模式行为相同。
翻动会话记录在全屏下靠鼠标滚轮与 `Ctrl-Up`/`Ctrl-Down` 的提问跳转。

改法：把括号里的补充改成实际行为，两种模式一致；并补一句全屏下翻动会话记录的入口。

### `config-files.md`

`docs/{zh,en}/configuration/config-files.md:641` 的 `tui_mode` 说明现在只说
"部分组件支持鼠标交互"，既没说全屏有什么、也没说切换要重启。改成反映矩阵：

- `regular`：渲染进终端滚动缓冲区；
- `fullscreen`（实验性）：改用备用屏幕，会话记录变成应用内可滚动区，并额外提供
  应用内鼠标选区复制、`Ctrl-Shift-F` 会话记录搜索、`Ctrl-Up`/`Ctrl-Down` 提问跳转；
- 两种模式的面板、对话框与键位一致；
- 切换后需重启生效。

`config.ts:364` 生成的注释行（`tui_mode = "regular" # "regular" | "fullscreen" ("fullscreen" is experimental)`）
保持不变——它是对着已生成的 `tui.toml` 写的，改它会让已落盘的文件与模板对不上。

### `tui-mode-selector` 的说明文案

`apps/kimi-code/src/i18n/locales/{en,zh}.ts` 的 `tuiModeSelector.fullscreenDesc`
现在是"备用屏幕，支持应用内滚动、选择和会话记录搜索。"——与实现相符，不改。
本轮**不新增**用户可见文案，因此 locale 文件只做校验，不做改动。

## R4 — 列表对话框的鼠标交互

### 现状机制

全屏渲染器在启动时打开鼠标上报（`tui-alt-screen.ts:66-67`），终端的原生鼠标行为
（选区、滚轮、链接）因此让位给应用：事件由 `handleMouseEvent` 分发到 overlay 与
布局树里的组件（`tui-alt-screen.ts:1042-1068`）。**组件不实现 `handleMouse`，
指针就落不到它身上**。

常规模式相反：应用没有打开鼠标上报，终端自己处理鼠标，所以常规模式的对话框
从来不需要 `handleMouse`——"点不动"这件事只在全屏模式存在。

盘点结果：45 个对话框组件里只有 `choice-picker`（及其 13 个子类）实现了鼠标处理；
模型选择器、会话列表、供应商管理、撤销选择器、目标队列、实验开关、模型切换确认、
缓存提示一律没有。

### 改动：一个共享路由

新增 `apps/kimi-code/src/tui/utils/list-mouse.ts`：

- **`ListMouseRouter<T>`** —— 路由器。面板在 render 时记录每行的矩形
  （`ListRowRegion`：`start`/`end`/`index`，面板自身坐标系），鼠标事件交给路由器：
  指针移动高亮该行、滚轮翻页、点击选中该行。
- **`ListCursor<T>`** —— 面板暴露给路由器的最小接口（`items`/`selectedIndex`/
  `pageCount`/`moveTo`/`page`）。`searchableListCursor()` 把共用的
  `SearchableList` 适配进来；自带列表的面板（供应商管理器）直接实现这个接口。
- **`listMouseDispatch()`** —— 把面板的回答包成容器期望的 dispatch 形状
  （`TuiMouseDispatchResult` 需要 `target` 元数据）。

两个语义细节沿用 `choice-picker` 的既有行为，不重新发明：

- **未持焦时第一次点击只取焦点**（`{handled: true, focus: true}`），避免"打开面板的
  那一下点击"直接选中一行。
- **稳定窗口**（`isSettlingClick`，300ms）内的点击被忽略，同上。

### 谁接上了

| 面板 | 挂载方式 | 选中动作 |
| --- | --- | --- |
| 选择器系列（13 个子类） | 编辑器槽位 | 选中该选项（既有实现，改为共用路由） |
| 模型选择器 `model-selector` | 编辑器槽位 | 选中该模型，带当前 thinking 档位 |
| 分供应商模型选择器 `tabbed-model-selector` | 编辑器槽位 | 转发给当前标签的内层列表（按标签条高度偏移） |
| 会话列表 `session-picker` | 编辑器槽位 | 切到该会话 |
| 撤销选择器 `undo-selector` | 编辑器槽位 | 撤销该条 |
| 实验开关 `experiments-selector` | 编辑器槽位 | 切换该实验的草稿 |
| 模型切换确认 `model-switch-confirm-dialog` | 编辑器槽位 | 选中该选项 |
| 缓存提示 `cache-hint-dialog` | 编辑器槽位 | 选中该选项 |
| 目标队列 `goal-queue-manager` | 编辑器槽位 | 标记该目标待重排 |
| 供应商管理 `provider-manager` | 编辑器槽位 | 命中"新增平台"行时触发新增 |
| 权限提示 `start-permission-prompt`（含目标 / 群组 / hello-world 三个子类） | 编辑器槽位 | 选中该选项 |
| 信任提示 `trust-prompt` | 编辑器槽位 | 选中该选项 |
| 任务浏览器 `tasks-browser` | 接管 layout root | 选中该任务（点详情栏不算命中） |
| 帮助面板 `help-panel` | 编辑器槽位 | 无（只有滚轮：滚自己的内容） |

### 三个形状，三种接法

1. **一列可选的行**（选择器、模型、会话、供应商、权限提示、信任提示、任务列表）：
   `ListMouseRouter` + 行矩形。
2. **双栏**（任务浏览器：左列表 + 右详情）：行矩形多带一个**列区间**，点在详情栏
   不算命中列表行。
3. **只会滚、不用选**（帮助面板）：`ScrollMouseRouter` —— 滚轮 3 行一档，到底不动。

### 为什么不是"每个面板各写一份"

20 多个面板各写一份 `handleMouse` 就是 20 多份会漂移的实现。新增一个对话框还会
再漏一次。路由器把"行矩形 → 行索引 → 选中哪一项"这条链收在一处，面板只负责
提供行矩形和"选中之后做什么"。

### 明确不接的

- **插件市场面板**（市场状态 + 每行 4 种动作 + 标签条）、**问题对话框**
  （多标签页 + 单选/多选 + "其他"自由输入）、**供应商表单**、**API Key 输入框**、
  **Astron 设置**：形状不是"一列可选的行"，各有各的命中规则，另做一轮。
- **分供应商模型选择器的标签条本身**：`renderTabStrip`（`utils/tab-strip.ts`）只返回
  一行字符串，不暴露标签几何；点标签切供应商要先给标签条加几何输出。标签仍可用
  `Tab`/`Shift-Tab` 切换。

## 依赖关系

```
R1 (dialog-host.ts 一处声明)
  ↓ 无逻辑依赖，只影响回归定位
R2 (文档)  ← 与 R1 独立
R3 (文档)  ← 与 R1 独立
```

R2 与 R3 描述的是 R1 之后的**实际行为**，所以实现顺序上 R1 先落地、文档后改，
但两者之间没有编译期依赖。

## 验证

每条任务的验收断言写在 `tasks.md`，全部是可 `bun:test` 真实失败/通过的断言。

- `apps/kimi-code` 跑受影响的测试文件：`test/tui/fullscreen-layout.test.ts`、
  `test/tui/utils/screen-takeover.test.ts`、`test/tui/commands/tui-mode-preferences.test.ts`。
- R1 只改应用层，不改 pi-tui 的对外类型，不需要升到根 `bun run test`；
  但 R1 动了"面板拿键"这条所有对话框共用的路径，因此要跑整个 `apps/kimi-code` 包。
- `bun run lint`、`bun run check:no-comments` 必须绿。
- locale 门禁：本轮不新增文案，仍跑一次 `check-t-call-coverage` 作为证据。
