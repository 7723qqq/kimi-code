# Requirements — 修复「批准框点不开」（状态栏 region 鼠标链路）

## 1. 目标

让**鼠标点击**在批准（approval）提示上生效，与键盘能力对齐。当前状态：键盘完全可用（`1`/`2`/`3`、`↑`/`↓`、`Enter`、`Esc`、`Ctrl+T` 折叠），鼠标点击被静默吞掉。

## 2. 受众

使用 TUI（普通模式与全屏模式）的最终用户；以及后续维护 `status-surface` 的开发者。

## 3. 已确认的根因（详见 `bug-approval-mouse.md`）

| # | 位置 | 事实 |
| --- | --- | --- |
| C1 | `apps/kimi-code/src/tui/components/chrome/status-surface/index.ts:270-276` | `click + left` 时先判 `wantsFocus()`，为真则 `return { handled: true }`，永不走到 `toggleFold` |
| C2 | `.../regions/approval-region.ts:171-174` | `handleMouse` 空实现，返回 `undefined` |
| C3 | `.../regions/approval-region.ts:177-179` | `wantsFocus()` 恒为 `true` |
| C4 | `.../regions/approval-region.ts:117-119` | `hasHiddenContent()` 在展开态返回 `false`，导致 surface 的 `toggleFold` 无法折叠它 |
| C5 | `apps/kimi-code/test/tui/components/panels/status-surface.test.ts:336-347` | 现有用例断言「wantsFocus 优先于折叠」，修复必须同步处理 |

C1+C2+C3 共同造成：点击被标记为已处理，但界面无任何变化。该缺陷在**普通模式与全屏模式下同样发生**；全屏额外经过 `GutterContainer` 的 gutter 平移与 layout box 的 `clip` 命中（`packages/pi-tui/src/layout.ts:482`），故表现更彻底。

## 4. 边界

- **B1 不改 `packages/pi-tui`。** 修复限于 `apps/kimi-code/src/tui/`。（全屏坐标一致性问题不在本次范围。）
- **B2 键盘行为零回归。** `status-surface-approval.test.ts` 现有 18 个用例必须全部继续通过。
- **B3 其他 region 行为不变。** `updates` 的「点击取焦点」、`todo` 的「点击折叠」保持现状。
- **B4 不引入新的 i18n 文案**（若必须新增提示，须同时补 `en`/`zh` 并由 `check-locale-keys` 通过）。
- **B5 不改批准的业务语义**：`selectChoice` / `reject` 的调用路径与响应类型不变。

## 5. 明确不做

- 不重做状态栏布局、不调整 `STATUS_SURFACE_MAX_ROWS` 预算规则。
- 不修 `GutterContainer` 的高度错配（记录在案，另行处理）。
- 不新增「鼠标悬停高亮」等本次未被要求的交互。
- 不改动批准面板的渲染外观（除鼠标命中所需的行索引记录外）。

## 6. 验收总纲（可执行）

| 编号 | 验收项 | 判定方式 |
| --- | --- | --- |
| A1 | 折叠态点击摘要行 → 展开 | 单测断言 `region.isExpanded() === true` |
| A2 | 展开态点击选项行 → 触发对应 choice | 单测断言 `panel.selectChoice` 收到第 N 项 |
| A3 | 已聚焦的 region 不再吞掉点击 | 单测断言 `focusRegion` 返回 false 时仍走到 region/折叠逻辑 |
| A4 | 键盘 18 例全绿 | `status-surface-approval.test.ts` |
| A5 | 状态栏鼠标 6 例全绿 | `status-surface.test.ts` |
| A6 | 类型检查通过 | `cd apps/kimi-code && bun run typecheck` |
| A7 | 无 i18n 回归 | `bun scripts/check-locale-keys.mjs` |
