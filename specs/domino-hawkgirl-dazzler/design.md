# Design — 让批准区的鼠标点击生效（修正版）

需求见 `requirements.md`（B1–B5、A1–A7），根因见 `bug-approval-mouse.md`（C1–C5）。

## 0. 一句话设计

**只改一个文件**：让 `ApprovalRegion.handleMouse` 自己处理点击并返回 `{ handled: true }`。surface 的分支顺序**保持不动**。

```
现状：click → region.handleMouse → undefined → wantsFocus(true) → return handled  ← 死路
目标：click → region.handleMouse → { handled: true }  ← 在到达 wantsFocus 之前就结束
```

## 1. 为什么不动 `StatusSurfaceComponent` 的分支顺序（对初版设计的修正）

初版设计打算把 `toggleFold` 上移到 `wantsFocus` 之前。核实后发现**这会破坏 `updates` 的既有行为**：

- `notify-panel.ts:265-267`：`hasHiddenContent()` 返回 `this.collapsed && this.channels.length > 0`。
- 即：一个**折叠且有内容**的 updates 面板，`hasHiddenContent()` 为 `true`。
- 调换顺序后，点击它 → `toggleFold` 返回 true → **展开**，而用户原本期望的是**取焦点**（`updates-region.ts:100-102` 明确声明 `wantsFocus() === true`）。

因此分支顺序**保持不变**。修复改由 region 自己承担：`index.ts:265-268` 已经给 region 留了优先通道——

```ts
const handled = region.handleMouse?.(local);
if (handled !== undefined && handled.handled !== false) {
  return { ...handled, handled: true };     // ← 在这里返回，永远到不了 wantsFocus
}
```

`ApprovalRegion` 只要返回 `{ handled: true }`，短路问题自然消失。

## 2. 落点（单文件 + 测试）

| 文件 | 改动 |
| --- | --- |
| `apps/kimi-code/src/tui/components/chrome/status-surface/regions/approval-region.ts` | 实现 `handleMouse`；修正 `hasHiddenContent`；`render` 中记录命中所需的几何 |
| `apps/kimi-code/test/tui/components/panels/status-surface-approval.test.ts` | 新增鼠标用例（A1、A2） |
| `apps/kimi-code/test/tui/components/panels/status-surface.test.ts` | **不改**（`prefers focus over folding` 用例继续有效，它用的是 FakeRegion） |

不动 `packages/pi-tui`（B1），不动 `status-surface/index.ts`。

## 3. 契约

### 3.1 行结构（由 `render` 决定，`approval-region.ts:97-107`）

| 行偏移 `y` | 折叠态 | 展开态 |
| --- | --- | --- |
| `0` | 摘要行 `▶ 标题  1.选项  2.选项 …` | 摘要行（同上） |
| `≥ 1` | — | 面板 body 的前 `budget-1` 行 |

### 3.2 `handleMouse` 行为

```ts
handleMouse(event: RegionMouseEvent): TuiMouseEventResult | undefined {
  if (this.payload === undefined) return undefined;
  if (event.type !== 'click' || event.button !== 'left') return undefined;

  if (event.y === 0) {
    const choice = this.choiceAtColumn(event.x);        // §3.3
    if (choice !== undefined) { this.respond(choice); return { handled: true, render: true }; }
    this.expanded = !this.expanded;                     // 非选项区 → 折叠/展开
    return { handled: true, render: true };
  }

  if (this.expanded) {
    const local = { ...event.raw, y: event.y - 1 };     // 摘要行占掉第 0 行
    return this.panel?.handleMouse?.(local);
  }
  return undefined;
}
```

要点：
- `y === 0` 的两次返回都带 `handled: true`，点击不再被 `wantsFocus` 吞掉（这正是根因 C1+C2+C3）。
- 展开态点击 body 转交面板，但 `ApprovalPanelComponent` 目前**没有** `handleMouse`（`approval-panel.ts` 只有 `handleInput`/`render`）。因此 T3 还需给面板加行级命中，或由 region 直接按行号映射（见 §3.4 的取舍）。

### 3.3 摘要行内的选项列区间

`renderSummary`（`approval-region.ts:197-220`）把选项拼成一行：`${number}.${text}` 之间用两个空格连接，前面还有 `▶ 标题  `。命中需要知道每个选项的列起点。

实现方式：在 `renderSummary` 中一边拼接一边累计 `visibleWidth`，把结果存到 `this.optionRanges`（`{ start: number; end: number }[]`）。`render` 每帧重算，`handleMouse` 直接读。**这是渲染与命中共享同一份计算**的唯一做法，避免两处各算一遍而漂移。

> 注意：`renderSummary` 用了 chalk 着色，`visibleWidth` 必须用 pi-tui 的 `visibleWidth`（去 ANSI 后计宽），不能用 `String.length`。

### 3.4 展开态的行 → choice 映射（两种实现，需选一）

面板 body 的行布局（`approval-panel.ts:372-459`）：`─` 边框 / `▶ 标题` / 空行 / display blocks / 空行 / **选项行**（每个 choice 一行，可能带 description 的续行）/ 空行 / 提示行 / `─` 边框。

- **D-I（region 记录选项行偏移）**：region 渲染 body 时扫描行内容，记录哪些行属于第 N 个 choice，`handleMouse` 直接映射。实现集中，但要解析渲染后的字符串。
- **D-II（面板自己实现 `handleMouse`）**：给 `ApprovalPanelComponent` 加 `handleMouse`，按 `selectedIndex` 语义处理 `y`（类似 `select-list.ts:123-160` 的写法）。region 只负责把 `y` 减去摘要行的 1 行偏移后转发。语义最清晰，面板最了解自己的行结构。

推荐 **D-II**：与 `updates-region.ts:95` 转发给面板的既有模式一致，且面板渲染时天然知道每个 choice 的行号（在 `render` 中记录 `choiceLineIndex[]` 即可）。

### 3.5 `hasHiddenContent` 修正（C4）

现状 `approval-region.ts:117-119`：`return this.payload !== undefined && !this.expanded;` → 展开后恒 `false`，`Ctrl+T` 与 surface 的 `toggleFold` 都无法折叠已展开的批准区。

修正为「展开后仍有被预算裁掉的内容时返回 true」：

```ts
hasHiddenContent(): boolean {
  if (this.payload === undefined) return false;
  if (!this.expanded) return true;
  return this.bodyRowsRendered > this.bodyBudgetGranted;   // render 中记录
}
```

`render` 已经在算 `first`（面板全量行）与 `bodyBudget`，记录两个数字即可，无额外渲染开销。

## 4. 约束

- 命中判定在 **region-local 坐标**内完成；`GutterContainer` 的 x 平移（`gutter-container.ts:141`）发生在 surface 收到事件之前，region 不再减 gutter。
- 鼠标作答必须走 `panel.selectChoice`（`approval-panel.ts:272-276`），不得直接调 `onResponse`——`requires_feedback` 的选项需要内联输入（B5）。
- 不新增 i18n key（B4）。
- `handleMouse` 只认 `click + left`；wheel 与 press 保持现状（surface 的 wheel 分支已按 `RegionKey` 路由，`index.ts:278-289`）。

## 5. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 调换 `toggleFold`/`wantsFocus` 顺序（初版设计） | 会把「点击折叠的 updates 面板」从取焦点变成展开，违反 B3（依据 `notify-panel.ts:265-267`） |
| 只调换顺序且不实现 region 鼠标 | 同上的 B3 破坏，且展开态仍无法用鼠标选项 |
| 让点击直接作答以省一次展开 | 批准不可逆，误点代价高；须用户先确认（D1） |
| 改 `packages/pi-tui` 统一全屏/主屏鼠标投递 | 违反 B1，回归面覆盖整个全屏交互；且 C1–C3 在两种模式都成立，与本 bug 无因果 |
| 恢复「批准面板独立挂载」 | 与 `b4d2851eae` 的统一方向相反，会把已修的键盘/预算/focus 问题带回来 |

## 6. 待用户确认（D1–D3）

- **D1 点击选项的语义**：直接作答 vs 只移动高亮后回车确认。
- **D2 点击摘要行非选项区**：折叠/展开（推荐），还是仅折叠时展开。
- **D3 展开态实现**：D-I（region 映射行）还是 D-II（面板实现 `handleMouse`，推荐）。

## 7. 验证

```bash
cd /home/administrator/kimi/kimi-code/apps/kimi-code
bun run typecheck                                                              # A6
bun run test -- test/tui/components/panels/status-surface-approval.test.ts     # A1 A2 A4
bun run test -- test/tui/components/panels/status-surface.test.ts              # A3 A5（不应改动）
cd /home/administrator/kimi/kimi-code && bun scripts/check-locale-keys.mjs     # A7
```

（该包的 `test` 脚本会先执行 `build:packages`，见 `apps/kimi-code/package.json`。）
