# Tasks — 修复批准区鼠标点击

设计见 `design.md`（修正版：**只改 `approval-region.ts` + 测试**，不动 surface 分支顺序，不动 pi-tui），需求见 `requirements.md`。

## T1 — 固定回归基线（先测，后改）

**目的**：动代码前把「现在坏成什么样」写成可执行断言。

**步骤**：
1. 运行现有测试，记录通过数：
   ```bash
   cd /home/administrator/kimi/kimi-code/apps/kimi-code
   bun run test -- test/tui/components/panels/status-surface.test.ts
   bun run test -- test/tui/components/panels/status-surface-approval.test.ts
   bun run test -- test/tui/components/chrome/gutter-container.test.ts
   ```
2. 在 `status-surface-approval.test.ts` 新增**修复前必然失败**的用例：
   ```ts
   it('expands when the folded summary row is clicked', () => {
     // payload + panel → region.render(ctx) → handleMouse(click(非选项列, 0))
     expect(region.isExpanded()).toBe(true);
   });
   ```

**验收标准**：
- AC1.1 三个现有文件全绿，通过数写入 `progress.md`。
- AC1.2 新用例在修复前失败，且失败原因是 `isExpanded()` 实际为 `false`。
- AC1.3 固定 `updates` 的折叠谓词事实：新增断言确认 `notify-panel` 在「折叠且有 channels」时 `hasHiddenContent() === true`（这是 T2 决策的依据，防止后续有人再提「调换顺序」）。

---

## T2 — 确认分支顺序保持不变（决策任务，非改码）

**依据**：`design.md` §1 与 §5。`notify-panel.ts:265-267` 的 `hasHiddenContent()` 为 `collapsed && channels.length > 0`，调换顺序会让点击折叠的 updates 面板变成展开而非取焦点。

**验收标准**：
- AC2.1 `apps/kimi-code/src/tui/components/chrome/status-surface/index.ts` 的 `git diff` 为空。
- AC2.2 `status-surface.test.ts:336` 的 `prefers focus over folding when the region wants focus` 用例**未修改**且通过。
- AC2.3 在 `progress.md` 记录该决策与被否决的替代方案（调换顺序）的原因。

---

## T3 — 实现 `ApprovalRegion` 的鼠标语义

**落点**：`.../regions/approval-region.ts`（+ `approval-panel.ts`，若选 D-II）

**步骤**：
1. `renderSummary` 中累计 `visibleWidth`，记录每个选项的列区间到 `this.optionRanges`（`design.md` §3.3）。必须用 pi-tui 的 `visibleWidth`，不能用 `String.length`（有 ANSI 着色）。
2. 实现 `handleMouse`（`design.md` §3.2）：
   - `type !== 'click' || button !== 'left'` → `undefined`。
   - `y === 0` 且 `x` 落在第 N 项列区间 → `panel.selectChoice(choices[N-1])`，返回 `{ handled: true, render: true }`。
   - `y === 0` 其他位置 → 切换 `expanded`，返回 `{ handled: true, render: true }`。
   - `y ≥ 1` 且展开 → 转交面板（D-II）或按记录的行映射（D-I）。
   - 其余 → `undefined`。
3. 按选定方案（D-II 推荐）让面板知道 choice 的行号，或让 region 记录。
4. 修正 `hasHiddenContent`（`design.md` §3.5），`render` 中记录 `bodyRowsRendered` / `bodyBudgetGranted`。

**验收标准**：
- AC3.1 折叠态点击摘要行第 2 项 → `panel.selectChoice` 收到 `choices[1]`（断言参数身份，不只是「被调用」）。
- AC3.2 折叠态点击摘要行非选项区 → `isExpanded() === true` 且未调用 `selectChoice`。
- AC3.3 展开态点击选项行 → 触发对应 choice。
- AC3.4 点击 `y` 超出区域 → `undefined`。
- AC3.5 展开态：body 被预算裁剪时 `hasHiddenContent() === true`；未裁剪时为 `false`。
- AC3.6 `requires_feedback` 的选项被鼠标点中时进入内联输入（走 `selectChoice` → `approval-panel.ts:272-276`），不直接提交。
- AC3.7 `handleMouse` 返回 `undefined` 时，点击仍能触发 surface 的 `wantsFocus` 兜底（即不破坏原有兜底语义）。

---

## T4 — 门禁：全量验证

**验收标准**（全部必须通过）：
- AC4.1 `cd apps/kimi-code && bun run typecheck` 通过。
- AC4.2 `bun run test -- test/tui/components/panels/status-surface-approval.test.ts` 通过，用例数 ≥ 18 + 新增数。
- AC4.3 `bun run test -- test/tui/components/panels/status-surface.test.ts` 通过（且文件未被修改）。
- AC4.4 `bun run test -- test/tui/components/panels/status-surface-regions.test.ts` 与 `status-surface-budget.test.ts` 通过。
- AC4.5 `bun run test -- test/tui/components/chrome/gutter-container.test.ts` 通过。
- AC4.6 `cd /home/administrator/kimi/kimi-code && bun scripts/check-locale-keys.mjs` 通过（B4）。
- AC4.7 `bun scripts/check-no-comments.mjs` 未新增违规（对照 `scripts/no-comments-baseline.txt`）。
- AC4.8 `git diff --stat` 只含 `design.md` §2 表格列出的文件；`packages/pi-tui` 与 `status-surface/index.ts` 的 diff 为空。

---

## T5 — 手工验证（需要 TUI 环境）

**验收标准**：
- AC5.1 普通模式（`tui_mode = "regular"`）：点击折叠摘要行的选项文本 → 得到对应响应。
- AC5.2 全屏模式（`tui_mode = "fullscreen"` 或 `KIMI_CODE_TUI_FULL_SCREEN=1`，见 `apps/kimi-code/src/tui/config.ts:24`）：同上。
- AC5.3 键盘路径无变化：`1`/`2`/`3`、`↑`/`↓`、`Enter`、`Esc`、`Ctrl+T` 照旧。
- AC5.4 `updates` 面板点击行为无变化（点击仍取焦点）。

---

## 依赖顺序

```
T1 ─ T2 ─ T3 ─ T4 ─ T5
```

T2 是决策任务，无代码产出；T3 依赖 T2 的结论（保持 `index.ts` 不动）。
