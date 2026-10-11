# Bug 分析 — 全屏/普通模式下批准框「点不开」

> 只读定位结论。修复需退出 spec 模式后执行。

## 1. 结论（一句话）

**`StatusSurfaceComponent.handleMouse` 的点击兜底在 `wantsFocus() === true` 时提前 return，而 `ApprovalRegion.wantsFocus()` 恒为 `true`、`handleMouse` 又返回 `undefined`——点击被消费掉，却只做了一次「已经发生过的」聚焦，既不展开也不作答。**

## 2. 精确根因（三处代码，可逐行核对）

### 2.1 兜底短路 —— `apps/kimi-code/src/tui/components/chrome/status-surface/index.ts:243-292`

```ts
const handled = region.handleMouse?.(local);
if (handled !== undefined && handled.handled !== false) {
  return { ...handled, handled: true };
}

if (event.type === 'click' && event.button === 'left') {
  if (region.wantsFocus?.(local) === true) {
    if (this.focusRegion(rect.id)) this.onRequestRender();
    return { handled: true, focus: true, render: true };   // ← 在这里返回，永不走到 toggleFold
  }
  if (this.toggleFold(rect.id)) return { handled: true, render: true };
}
```

点击批准区时的实际走向：

1. `region.handleMouse(local)` → `ApprovalRegion.handleMouse` 返回 `undefined`（见 2.2）→ 跳过。
2. 进入 `click + left` 分支。
3. `region.wantsFocus(local)` → `ApprovalRegion.wantsFocus()` 返回 `true`（见 2.3）→ 进入 if。
4. `this.focusRegion('approval')` → 该 region 已因 `autoFocus` 持有焦点，返回 `false`，**不触发重绘**。
5. 返回 `{ handled: true, focus: true, render: true }` —— 事件被标记为已处理。

**净效果：点击被吞掉，界面上什么都没发生。** 折叠态下点击摘要行不会展开；展开态下点击选项不会作答。

### 2.2 空实现 —— `regions/approval-region.ts:171-174`

```ts
handleMouse(event: RegionMouseEvent): TuiMouseEventResult | undefined {
  void event;
  return undefined;
}
```

### 2.3 恒真 —— `regions/approval-region.ts:177-179`

```ts
/** The approval owns the keyboard while it is up. */
wantsFocus(): boolean {
  return true;
}
```

### 2.4 对照：另外两个 region 为什么没暴露这个问题

| region | `handleMouse` | `wantsFocus` | 点击结果 |
| --- | --- | --- | --- |
| `todo-region.ts:90` | `return undefined` | `false`（`:96`） | 落到 `toggleFold` → **能折叠** ✅ |
| `updates-region.ts:95` | `this.panel.handleMouse(event.raw)` 转发给面板 | `true`（`:100`） | 面板自己处理 → 正常 ✅ |
| `approval-region.ts:171` | `return undefined` | `true`（`:177`） | **短路，什么都不做** ❌ |

`todo` 与 `approval` 的差别只在 `wantsFocus` 的返回值：`false` 才能走到折叠分支。批准区同时具备「返回 undefined」和「wantsFocus 为 true」，正好落在唯一无处理的分支上。

## 3. 这是一次回归（已用 git 证实）

`b4d2851eae`（feat(tui): unify the strip above the editor into a status surface）把批准面板从「替换编辑器挂载」改为「状态栏的一个 region」：

- 改前：`mountEditorReplacement(panel)`（现仍在 `kimi-tui.ts:2661`）→ 面板是独立挂载组件，鼠标事件由 pi-tui 直接投递给它。
- 改后：`dialog-host.ts:320` 走 `this.host.state.approvalRegion.show(payload, panel)` → 进入 region 体系，而 region 体系里批准区的鼠标能力**没有实现**。

同一次提交的说明文字里写着「one mouse pass, which records each region's row rect while painting and translates events into region-local coordinates」——鼠标通路是为 region 体系新建的，但批准区的行级语义没有跟着迁移。

旁证：`kimi-tui.ts:2437-2448` 的注释记录了同一次迁移中**键盘**侧的同类缺陷已被修（`toggle` 曾经也点不开/按不开），**鼠标**侧没有对应修复。

## 4. 行为被测试固化

`apps/kimi-code/test/tui/components/panels/status-surface.test.ts:336-347`：

```ts
it('prefers focus over folding when the region wants focus', () => {
  const updates = new FakeRegion('updates', { want: 3, hidden: true, focusOnClick: true });
  ...
  expect(surface.focusedRegion()).toBe('updates');
  expect(updates.expandedCalls).toEqual([]);   // ← 明确断言「不折叠」
});
```

该用例把「wantsFocus 优先于折叠」写成了预期行为。修复时必须**同时**决定：这条规则是否仍成立（例如改为「region 先处理鼠标，未处理时才折叠」），并同步更新这个用例，否则测试会挡住修复。

## 5. 全屏 vs 普通模式

| 环节 | 普通模式（主屏） | 全屏（备用屏） |
| --- | --- | --- |
| click 合成 | `packages/pi-tui/src/tui.ts` 的 `Container.handleMouse` → `dispatchMouseEvent` | `tui-alt-screen.ts:1458` 合成 click → `dispatchMouseToLayout`（`:890`） |
| 命中判定 | 按子组件渲染高度逐层累加 `event.y` | `getLayoutBoxesAt` 要求命中 `box.clip`（`packages/pi-tui/src/layout.ts:482`） |
| 外层包装 | `GutterContainer`（`apps/kimi-code/src/tui/components/chrome/gutter-container.ts:139`）做 gutter 平移 | 同上，且 `height` 来自 layout box 的 `box.lines?.length ?? box.rect.height`（`tui-alt-screen.ts:904-910`） |

**结论：§2 的短路在两种模式下都会发生**，因此「点不开」不是全屏独有。全屏额外叠加了坐标/裁剪的复杂度（`GutterContainer` 依赖 `event.height` 与自身渲染高度一致；全屏下 `statusSurfaceContainer` 受 dock 的 `maxSize: STATUS_SURFACE_MAX_ROWS` 约束，`tui-state.ts:224-227`），所以全屏下更容易表现为「完全没反应」。

建议修复时**先修 §2（两种模式都受益）**，再视需要核对 §5 的坐标一致性。

## 6. 修复方案（三选一，需用户确认交互语义）

### 方案 A — region 先行：让 region 的鼠标处理优先于 wantsFocus 兜底（推荐）

- 在 `StatusSurfaceComponent.handleMouse` 中调整顺序：`region.handleMouse` 返回未处理时，**先尝试 region 的行级命中**，再考虑 `wantsFocus`/折叠。
- 给 `ApprovalRegion` 实现 `handleMouse`：
  - 折叠态：点击摘要行 → 展开（或点中第 N 个选项文本 → 直接作答，取决于语义选择）。
  - 展开态：点击选项行 → 移动高亮 / 直接作答；点击正文 → 保持。
- 需要 `renderSummary` 记录选项文本的列区间，或在 `handleMouse` 里按 `x` 分段。
- 改动：`approval-region.ts`（+40~70 行）、`status-surface/index.ts`（调整分支顺序）、`status-surface.test.ts`（更新被固化的用例 + 新增鼠标作答用例）。
- 不动 `packages/pi-tui`（上游依赖）。

### 方案 B — 只修顺序，不改 region

- 把 `wantsFocus` 兜底改为「先尝试 `toggleFold`，折叠无变化时才聚焦」。
- 效果：点击折叠态的批准区能展开，但**展开后仍无法用鼠标选中选项**（选项语义缺失）。
- 改动最小，但只修一半。

### 方案 C — 恢复「批准面板独立挂载」的鼠标能力

- 让 `ApprovalPanelComponent` 自己实现 `handleMouse`，并在 region 里原样转发（照 `updates-region.ts:95` 的写法）。
- 好处：行级语义与面板的 `selectedIndex` 天然一致，不用在 region 里重复计算列区间。
- 代价：面板需要知道自己的行偏移（region 会先渲染摘要行，再渲染面板 body），偏移量需由 region 传入。

## 7. 待确认（阻塞修复）

1. **点击语义**：点选项文本 = 直接作答（快），还是只移动高亮、回车才作答（安全，批准不可逆）？
2. **点击摘要行**：是否允许「点任意位置即展开」？
3. **被固化的测试**：`status-surface.test.ts:336` 的「wantsFocus 优先于折叠」是否允许改写？

## 8. 验证锚点（修复后）

- 新增：`status-surface-approval.test.ts` 中断言「click 折叠态摘要行 → 展开」「click 第 N 项 → `panel.selectChoice(choices[N-1])`」。
- 回归基线（现全部通过，修复后须仍通过）：
  - `apps/kimi-code/test/tui/components/panels/status-surface.test.ts`
  - `apps/kimi-code/test/tui/components/panels/status-surface-approval.test.ts`（18 例，纯键盘）
  - `apps/kimi-code/test/tui/components/chrome/gutter-container.test.ts`
- 运行：`cd apps/kimi-code && bun run test`（该包的 `test` 脚本会先 `build:packages`）。
