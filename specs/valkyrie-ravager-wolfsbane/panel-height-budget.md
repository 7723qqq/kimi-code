# Design — 全部 dock 面板的高度预算与滚动

用户反馈：「都需要滚动，update 也是。小的画面会出现整个屏幕都是这个面板。我们先聊聊有什么需要实现的、有什么实现的方式。」
用户在三个决策点上已选定：**全部 dock 面板统一处理** · **按优先级分配高度预算** · **尾部跟随 + 向上滚停止**。

本文件是方案讨论稿；确认后再动代码。

---

## 1. 问题与量化

### 1.1 现象

在 6 行终端上，Updates 面板渲染出 **8 行** —— 比整个屏幕还高，于是「整个屏幕都是这个面板」。

实测（`NotifyPanelComponent(() => rows)` + 40 行正文）：

| 终端行数 | 面板渲染行数 |
|---|---|
| 24 | 17 |
| 12 | 11 |
| 8 | 9 |
| 6 | **8** |
| 4 | **8** |
| 3 | **8** |

### 1.2 两层根因

**(a) 面板层：上限没有把「自身开销」算进去。**
`notify-panel.ts` 的预算是 `min(12, floor(rows/2))`，只约束**正文**行数；
面板还有 2 行边框、2 行内边距、1 行前置空行，共 **5 行固定开销**。
所以「正文预算 + 5」才是真实占高 —— 在 `rows <= 10` 时必然超过终端。

**(b) 布局层：dock 没有总预算，各面板互不知情。**
`tui-state.ts:203-208` 往 `dockContainer` 里塞了 6 个东西：

```
activityContainer   shrink:1 minSize:0
panelsRow           shrink:1 minSize:0     ← todo + updates
queueContainer      shrink:1 minSize:0
btwPanelContainer   shrink:1 minSize:0
surveyContainer     shrink:0 minSize:0
editorContainer     shrink:1 minSize:3
```

`allocateStackSizes`（`packages/pi-tui/src/components/stack.ts:148`）**确实**会按
`availableSize` 收缩子项（`distribute(..., 'shrink')`），所以并非「不收缩」；
问题是 `minSize: 0` 允许多个高需求面板**同时**保留可观高度，而它们的**总和**没有上限。
`shrink` 权重按尺寸加权分配，结果由各面板当下想要多少决定 —— 谁内容多谁就吃掉屏幕。

**(c) 一个被我第一版判断错的点，已纠正：`StackLayoutEntry.maxSize` 是**有效**字段。**
类型在 `packages/pi-tui/src/layout-node.ts:16`，读取在 `components/stack.ts` 的
`allocateStackSizes()`（`clampSize` 与 `distribute` 都用它），而渲染路径
`packages/pi-tui/src/layout.ts:199` **确实**调用了 `allocateStackSizes` —— 所以 `maxSize`
在真实布局里生效（实测：给一个 40 行的子项声明 `maxSize: 4`，加 3 行子项共渲染 7 行，被正确夹到 4）。

这带来一个重要简化：**声明式限高可用**，不必为「夹高度」写面板内代码。
但有个关键限制：`maxSize` 是**静态数字**，无法表达「半屏」这种**随终端变化**的约束。
所以正确分工是：

- **静态硬上限** → 用 `maxSize`（放在 `tui-state.ts` 的 dock 装配里，声明式、可读）
- **随终端变化的份额** → 只能由面板自己算（读 `terminalRows()`），因为它们才知道
  自己的固定开销（边框/内边距）有多少

另一个限制：`panelsRow` 是 **HStack**，`maxSize` 在 HStack 上约束的是**宽度**；
todo 与 updates 的**高度**不在这一层，需作用于 dock（VStack）或各自的行容器。

### 1.3 已有的三套仓内先例（不新发明概念）

| 先例 | 做法 | 出处 |
|---|---|---|
| **`btw-panel`（最完整，应作为对齐目标）** | `followTail` 尾部跟随；`maxScrollTop`；`scroll(direction)`；上限 `collapsedBodyLimit()` = `max(3, floor(terminalRows/3))`；`fitBodyLines()` 统一裁剪/补齐；**已有测试覆盖小终端**（`rows=4 → 恰好 3 行`） | `components/panes/btw-panel.ts:43-49,165-200,257-264` |
| **`todo-panel`** | 固定 `MAX_VISIBLE = 5` + `ctrl+o` 展开/折叠；且不是简单截断，而是**按优先级挑该看的**（进行中 → 待办 → 刚完成） | `components/chrome/todo-panel.ts:47,142-215` |
| **`prompt-optimize-panel`** | `MAX_DIFF_LINES=24` → `ctrl+o` 展开到 `MAX_EXPANDED_DIFF_LINES=200`；「先摘要、按需展开」 | `components/dialogs/prompt-optimize-panel.ts:33-40,156` |

`BtwPanelComponent` 的选项形状已经是正确抽象，直接推广即可：

```ts
export interface BtwPanelOptions {
  readonly markdownTheme: MarkdownTheme;
  readonly canUseScrollKeys: () => boolean;   // ← 滚动是否允许的守卫
  readonly onPrompt: (...) => void;
  readonly terminalRows: () => number;        // ← 尺寸来源是注入的
}
```

---

## 2. 要实现的（需求清单）

按「用户可见行为」写，每条都可验证。

| # | 需求 | 验收（可执行） |
|---|---|---|
| R1 | **任何面板在任何终端高度下都不得占满整屏**：单个面板占高 ≤ `floor(rows/2)` 且 ≤ 自身硬上限，**开销计入**其中 | 在 `rows ∈ {3,4,6,8,10,12,24}` 下渲染每个面板，断言 `lines.length <= max(3, floor(rows/2))` |
| R2 | **dock 全体同样不得撑爆**：所有可见面板 + editor + footer 之和 ≤ 终端高度 | 集成测试：`rows=8`、同时打开 todo+updates+queue+btw，断言合成屏幕行数 == `rows` 且 editor 可见 |
| R3 | **内容超出时可滚动**，且**默认尾部跟随**（新内容自动可见）；一旦向上滚即停止跟随，回到底部恢复跟随 | 单测：滚轮/按键向上后 `followTail=false`；再滚到底 `followTail=true` |
| R4 | **键盘可滚**且不夺取常规输入：仅当该面板持有焦点时才消费 `↑`/`↓` | 集成测试：未聚焦时 `↑` 仍是输入历史/光标；聚焦后变为滚动 |
| R5 | **折叠态给出可发现的提示**：被裁剪时显示「还有 N 行」或 `ctrl+o` 类提示，且提示**不挤掉更重要的信息**（如未读圆点） | 单测：断言提示存在；并在窄宽度下断言未读标记仍可见 |
| R6 | **小屏优雅降级**：优先保 editor（输入）与当前活动面板；低优先级面板退化为单行标题 | 集成测试：`rows=6` 时 editor 至少 3 行、活动面板至少 3 行，其余为 0 或 1 行 |

**明确不做**（本轮）：不做新的「面板焦点」概念（那是最贵的方案，见 §3 方案 C 被否理由）；
不改 dialog 类面板（它们走 overlay/replacement，不参与 dock 竞争）。

---

## 3. 实现方式（三个方案）

### 方案 A — 每面板自管（「各自修」）
每个面板自己读 `terminalRows()`、自己算上限、自己实现滚动。
- ✅ 改动局部、可分开评审、互不影响
- ❌ 规则分散在 6 处，`rows<=10` 的**总预算**仍无人负责 → R2/R6 **无法达成**
- ❌ 新面板容易再次遗漏（正是当前 bug 的成因）
- 结论：**不足以解决问题**，仅作为方案 B 的组成部分

### 方案 B — 共享预算模块 + 各面板接入 + `maxSize` 静态兜底（推荐）
分两层，各用其擅长的手段：

**层 1（静态、声明式）**：在 `tui-state.ts` 的 dock 装配里给每个容器声明 `maxSize`
（如 updates 12、todo 5、queue 5、activity 2）。这一层**不写代码逻辑**，
纯声明即可挡住「单个面板无上限」的问题，`layout.ts:199` 会如实夹住。

**层 2（动态、随终端）**：新增小模块（例如 `apps/kimi-code/src/tui/utils/panel-budget.ts`）
集中处理随终端变化的部分与总预算：

```ts
/** 固定开销：边框 + 内边距 + 面板自己的 header 行。 */
export interface PanelBudgetSpec {
  readonly id: 'todo' | 'updates' | 'btw' | 'queue' | 'activity' | 'survey';
  readonly overhead: number;        // 边框/内边距等固定占高
  readonly hardCap: number;         // 与层 1 的 maxSize 对应
  readonly minBody: number;         // 至少留几行正文（否则退化为 1 行标题）
  readonly priority: number;        // 小屏时谁先被保
}

/** 该面板本次最多能占多少行（总行数，含 overhead）。 */
export function panelCap(spec: PanelBudgetSpec, rows: number): number;

/** dock 的总预算：终端高度 - editor 最小高度 - footer。 */
export function dockBudget(rows: number, editorMin: number, footerRows: number): number;
```

- **上限算法（处理 §1.2(a)）**：`cap = min(spec.hardCap, floor(rows/2))`，
  再**减去 overhead** 得正文预算 —— 而不是「正文预算 + overhead」。
- **总预算算法（处理 §1.2(b)）**：按 `priority` 依次分配，前一个拿够后剩下的才给下一个；
  不够时低优先级面板返回 `minBody === 0 ? 0 : 1`（1 行标题）。
- **面板侧统一接入**：沿用 `BtwPanelOptions` 的形状（`terminalRows: () => number`），
  面板只消费一个数字，不关心预算怎么算 —— 与既有 btw-panel 一致。
- ✅ R1/R2/R6 可达成；规则集中在两处（声明 + 一个模块），新面板必须显式声明
- ✅ 复用 `btw-panel` 已验证的 `followTail`/`maxScrollTop`/`scroll()` 模式（满足 R3）
- ⚠️ 需改动 6 个面板 + `tui-state.ts` 的 dock 装配；比方案 A 大，但这是 R2/R6 的必要成本

### 方案 C — 小屏单面板模式（「一次只显示一个」）
`rows <= N` 时只保留当前活动面板，其余折叠为一行切换提示。
- ✅ 终端极小时最可用
- ❌ 引入新的「面板焦点/切换」概念，与现有 `Ctrl+N`/`Ctrl+T` 语义重叠，需重新定义键盘表
- ❌ 改动最大，且用户没要求这个交互
- 结论：**本轮不做**；若方案 B 之后小屏仍不满意，可在此之上追加

### 被否的替代做法

1. **只靠 `maxSize` 声明式限高** —— 它确实有效（见 §1.2(c)），但只能表达静态数字，
   无法表达「≤ 半屏」；且小屏时**总预算**问题（§1.2(b)）依然无解。
   结论：作为**方案 B 的一部分使用**（静态硬上限用 `maxSize`），不作为完整方案。
2. **把 dock 改成一个滚动容器** —— 会让「编辑器永远可见」这一硬约束失效（用户打字时看不到输入框）。
3. **只给 notify-panel 加下限保护** —— 治不了 todo+btw+queue 同时展开的叠加场景。
4. **修改 `packages/pi-tui` 的布局合约** —— 它是 vendored fork（`UPSTREAM.md` 记录同步点），
   优先在 app 侧解决，避免扩大与上游的差异面。

---

## 4. 优先级建议（决定小屏时谁先被牺牲）

依据「用户在等什么」排序，确认或调整：

| 优先级 | 面板 | 理由 | 建议上限 |
|---|---|---|---|
| 保 | **editor** | 没有它无法输入 | `minSize: 3`（现状，保持） |
| 1 | **activity** | 「正在做什么」是等待时唯一有用的信息 | 1–2 行 |
| 2 | **updates** | 子 agent 的进度；当前 bug 主体 | 硬上限 12 行，且 ≤ 半屏 |
| 3 | **todo** | 计划视图，可随时 `ctrl+t` 展开 | 固定 5 行（现状） |
| 4 | **queue** | 排队消息，不看不影响 | 硬上限 5 行 |
| 5 | **btw** | 用户主动发起的旁支问答，可重开 | `terminalRows/3`（现状） |
| 6 | **survey** | 一次性问卷，不紧急 | 折叠为 1 行 |

注：`surveyContainer` 目前是 `shrink: 0`（唯一不参与收缩的），与「最不紧急」矛盾，
建议一并改为可收缩。

---

## 5. 分阶段落地（每阶段可独立验收）

### ✅ 阶段 1（已完成）修 bug 主体：预算含面板开销

- `notify-panel.ts`：`PANEL_OVERHEAD_ROWS = 5` 成为显式常量，上限由「正文预算」
  改为「总行数预算」（`min(12, floor(rows/2))` 再减开销）；不足最小正文时退化为单行 stub。
- `queue-pane.ts`：同类 bug 且原本**完全无上限**（有多少排队消息渲染多少行）。
  已加同样的总行数预算（上限 8）、保留**最新**若干条，并加「隐藏了 N 条」提示。
- 验证：`rows ∈ {24,12,10,8,6,4,3,2}` 下面板高度**每档都 ≤ 预算**（此前 6 行终端渲染 8 行）。

### ✅ 阶段 3（已完成）dock 静态上限 + 总预算

- `tui-state.ts`：给 dock 各容器声明 `maxSize`（activity 6 / panelsRow 18 / queue 8 /
  btw 18 / survey 5），作为「面板忘记自查时仍不得吃屏」的第二道保险；
  `surveyContainer` 由 `shrink: 0` 改为 `shrink: 1`（原为唯一不参与收缩者，与「最不紧急」矛盾）。
- 新增 `test/tui/components/panels/dock-height-budget.test.ts`（22 条），
  **直接驱动 `renderLayoutFrame`**：断言 dock 各行分配高度之和恒等于终端高度、
  editor 始终 ≥3 行、Updates 盒 ≤ `min(18, max(2, floor(rows/2)))`。
  （刻意不用 `component.render()`：裸 render 不按 viewport 裁剪，会写出假绿测试。）

### ✅ 阶段 2（部分完成）展开态的 todo 列表

普查后只有一处仍需处理（其余面板要么已有滚动、要么结构上有界）：

| 面板 | 上限 | 滚动 | 结论 |
|---|---|---|---|
| `notify-panel` | ✅ 总行数预算 | ✅ `↑↓`（上一轮） | 完成 |
| `todo-panel` **展开态** | ❌→✅ | ❌→✅ `shift+↑↓` | **本轮修复** |
| `todo-panel` 折叠态 | ✅ 固定 5 项 | 不需要 | 本就正确 |
| `queue-pane` | ✅ 本轮加（上限 8） | 不需要 | 只显示最新若干条 + 隐藏计数 |
| `btw-panel` | ✅ `terminalRows/3` | ✅ 已有 `followTail` | 本就已经是标杆 |
| `activity-pane` | 结构有界（≤3 个固定子项） | 不需要 | 实测确认 |
| `survey-panel` | 结构有界（标题 + 固定选项 ≤5 行） | 不需要 | 实测确认 |

**todo 展开态**：`todo-panel.ts` 的两条 `if (this.expanded)` 分支都在无上限地 push，
实测 60 项在 24 行终端渲染 **63 行**。现改为总行数预算（上限 `EXPANDED_MAX_ROWS = 16`
且 ≤ 半屏，扣除 `PANEL_OVERHEAD_ROWS = 3`），并加 `shift+↑/↓` 滚动。
键位选择依据：`↑/↓` 归编辑器（光标与历史），`ctrl+shift+↑/↓` 已被 alt-screen 的
prompt 跳转占用，`shift+↑/↓` 经核实无归属。

**本轮又修正两个自身缺陷**（都是"测试看似通过但行为不对"）：
1. `hiddenExpandedRows()` 未判断 `expanded`，折叠态返回 52 而非 0。
2. 滚动 clamp 用错量：以"隐藏行数"为上限，导致到底后 `scrollBy` 仍报移动而视图不变。
   正确上限是 `条目数 − 可见行数`（底部提示行永不滚走），二者并不相等。

### 阶段 4（待做）统一提示与降级

统一的「还有 N 行 / ctrl+o」提示，保证提示不挤掉未读标记（R5）。

### 实测数据（阶段 1+3 后）

`renderLayoutFrame(root, 60, rows)` 下 dock 各行分配高度：

| 终端行数 | scrollback | panelsRow | editor | 合计 |
|---|---|---|---|---|
| 24 | 9 | 12 | 3 | 24 |
| 12 | 3 | 6 | 3 | 12 |
| 10 | 5 | 2 | 3 | 10 |
| 8 | 3 | 2 | 3 | 8 |
| 6 | 1 | 2 | 3 | 6 |
| 4 | 1 | 0 | 3 | 4 |

合计恒等于终端高度，编辑器始终保留 3 行 —— 这正是「整屏都是面板」不可能再发生的形式化表述。

---

## 6. 风险

- **R2 的集成测试需要真实布局路径**（`TuiAltScreen` + `renderNow`），不能只用 `component.render()`
  —— 裸 `VStack.render()` 不会按 viewport 裁剪（实测 10 行视口返回 43 行）。测试须走 `setTerminalRows` 那条既有路径。
- 改动 `surveyContainer` 的 `shrink` 会影响问卷展示，需确认问卷在 8 行终端下的最小可读形式。
- `packages/pi-tui` 是 vendored fork（`UPSTREAM.md` 记录同步点）：**优先在 app 侧解决**，
  不修改 pi-tui，避免增加与上游的差异面。

---

## 附录：Updates 面板的频道折叠（方案 A）

用户问「那么多频道有什么用」。核查后确认这**不是本 fork 引入的问题**：

| 项 | `upstream/main`（月之暗面） | 本 fork |
|---|---|---|
| 一 agent 一频道 + 标签条 | 有，注释一字不差 | 继承 |
| 标签条放不下就退化为只显示当前频道 | `title()` 的 `compact` 分支 | 继承 |
| 子 agent 结束后不移除频道 | `subagent.completed` 只清 pending | 继承 |
| 面板高度上限 / 滚动 | **没有** | 本 fork 新增 |

**问题**：实测标签条在 ≥8 个频道时塌缩成只显示 1 个标签，`←/→` 导航失去目标列表。

**方案 A（已实现，最小侵入）**：`NotifyChannel.finished` + `markFinished(agentId)`；
渲染层 `tabStrip()` 把**已结束**且**非当前**的频道折叠为一个 `+N done` 标签。
当前查看的频道始终保留自己的标签（位置永不隐藏），被折叠频道的条目仍可用 `←/→` 访问
（折叠只改标签，不改模型，所以导航仍遍历全部频道）。

**实测效果**（100 列）：
- 改前 8 频道 → `explore(8)`（标签条消失）
- 改后 12 频道 → `main · explore · explore(12) · +10 done`（标签条存活）

**为何不选 B/C**：B（按类型合并）与 C（只留活动频道）都要改频道模型，与上游 merge 冲突面更大；
A 只碰渲染层 + 一个事件分支。


---

## 附录二：Updates 面板的鼠标交互

用户追问「交互」指**鼠标**（我先前误答键盘），并确认「全屏模式」指 TUI 模式设置里的
`regular` / `fullscreen` 布局选项。

**核查结论**：`notify-panel.ts` **完全没有** `handleMouse`（对照：`sticky-user-message.ts` 有，
`btw-panel.ts` 也没有）。而滚轮走 `routeWheel()`，它只查找 **`ScrollView`**（`getScrollViewsAt`），
所以滚轮**穿过面板落到 transcript** —— 实测在面板区域滚轮时 `transcript.scrollTop` 从 0 变 1。

**实现**（四项）：
- `handleMouse`：`wheel` 时 `focus()` + `scrollBy(wheelDelta)` 并返回 `{handled:true}`
  （不返回 handled 就会被 alt-screen 转给 primary scroll view）
- 同函数处理 `press` / `click`：用渲染时记录的标签列区间（`tabHitRanges`）命中测试
- 命中频道标签 → `switchToChannel`；命中 `+N done` → 切换 `finishedExpanded`
- `tabStrip()` 在拼装标签时累计可见宽度以记录每个标签的列区间

**两个自身 bug（实测抓到）**：
1. 只接受 `click`，但 alt-screen 派发 **`press`**（`click` 只在 release 时补发）→ 点击永不生效。
2. 曾用 `event.button === 'wheel-down'` 判方向；但 `TuiMouseButton` 只有
   `left|middle|right|none`，方向只能取自 `wheelDelta`（被 typecheck 拦住）。
3. 测试中一度在**错误的行**上点击（面板顶端有 1 行 spacer，边框在局部 y=1），
   改为从 `renderLayoutFrame` 取实际 `rect.y` 推导坐标，避免"测试自己算错却以为功能坏了"。
