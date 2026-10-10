# Tasks

方案见 `design.md`。每个任务给**可执行**的验收；能跑断言的不靠肉眼。

前置事实（已实测，不必重验）：
- 兜底 `setUnhandledClick` 只收到 `click`（需完整 press+release）。
- 面板若同时接受 `press` 与 `click`，一次真实点击会触发两次 —— 现有实现有 `+N done` 自我抵消的 bug。

---

## T0 — 先修掉工作区里半成品留下的红灯

**现状**：`notify.test.ts` 现在 **1 failed | 41 passed**，失败的是上一轮我自己加的那条：

```
NotifyController > scrolls the update with the mouse wheel over the panel, not the transcript
AssertionError: expected false to be true
```

它断言滚轮后 `notifyPanel.isFocused() === true` —— 也就是**把被否决的行为写成了断言**。
（上一轮我已把 `handleMouse` 里的 `focus()` 删掉，所以它现在红。）

改动：改写这条断言为「滚轮后 `isFocused()` 仍为 `false`，且 transcript 的 `scrollTop` 不变」。

**验收**
1. `notify.test.ts` 从 `1 failed | 41 passed` 变为 **42 passed**（改断言后，不新增用例也应全绿）。
2. 断言中**不出现** `isFocused()).toBe(true)`。

---

## T1 — 用 `followTail` 取代焦点耦合的滚动状态

改动 `apps/kimi-code/src/tui/components/chrome/notify-panel.ts`：
- `NotifyChannel` 加 `followTail: boolean`（初始 `true`）。
- `render()` 删除 `if (!this.focused) ch.scroll = 0`，改为按 `followTail` 决定是否 `= maxScroll`。
- `scrollBy(delta)` 对齐 `btw-panel.ts:257-264`：从 `followTail ? max : scroll` 起算，落点为 `max` 时置 `followTail = true`。
- 翻条目 / 切频道 / 切标签 / `switchToChannel` 均置 `followTail = true`。
- `blur()` 不再遍历清空 `scroll`。

**验收**
1. 单测：`scrollBy(-1)` 后 `render()` 不再含最新行；再 `scrollBy(+1)` 回到底部后，新 `upsert` 的内容能出现在渲染中（跟随恢复）。
2. 单测：未聚焦状态下 `render()` **不会**把 `scroll` 归零（可用「滚动后 render 两次，窗口位置不变」断言）。
3. `grep -n "if (!this.focused) ch.scroll" notify-panel.ts` 无输出。

## T2 — 滚轮不再抢键盘焦点

改动 `handleMouse` 的 wheel 分支：删除 `if (!this.focused) this.focus();`。

**验收**
1. 单测：`handleMouse({type:'wheel', wheelDelta:2, …})` 后 `isFocused()` 仍为 `false`。
2. 集成测（真实 `TuiAltScreen`）：滚轮后 `notifyPanel.isFocused() === false`，且 primary scroll view 的 `scrollTop` 不变。
3. 单测：`wheelDelta` 缺失或 0 时返回 `undefined`。

## T3 — 面板只接受 `click`，修掉双触发

改动 `handleMouse`：事件类型判定收窄为 `event.type !== 'click'`，删除 `press`。

**验收**
1. 单测：一次 `press` 事件**不**改变任何状态（返回 `undefined`）。
2. 单测：一次 `click` 使 `+N done` 从折叠切到展开（`isFinishedExpanded()` 变 `true`）。
3. 集成测（真实 alt-screen，完整 press+release）：单击 `+N done` 后 `isFinishedExpanded() === true`；再次单击回到 `false`。
   —— 这条是回归防护：旧实现在此断言下会失败。

## T4 — 面板实现 `Expandable` 能力，接入点击折叠

改动：
- `notify-panel.ts` 增加 `setExpanded` / `isExpanded` / `hasHiddenContent`，
  复用既有 `collapsed` 字段作为折叠状态；`hasHiddenContent()` = `collapsed && channels.length > 0`。
- `handleMouse` 对正文区域（非标签条行）返回 `undefined`，让 `GutterContainer` 兜底处理。
- `kimi-tui.ts` 的 `mountFooter` 附近或 `tui-state.ts` 装配处，为 `notifyPanelContainer`
  注册 `setUnhandledClick`，复用 `component-capabilities.ts` 的
  `isExpandable` / `hasHiddenContent` / `isExpandedComponent` 判定，不重写逻辑。

**验收**
1. 单测：`isExpandable(panel) && hasHiddenContent(panel)` 在折叠态为真，展开态 `hasHiddenContent` 为假。
2. 集成测：折叠态点击面板正文行 → 展开（stub 消失、边框出现）；展开态点击正文行 → 折叠回 stub。
3. 集成测：点击面板**标签条**行仍是切频道 / 切 `+N done`，**不**触发折叠切换。
4. 现有 `Transforms` 全部仍通过（点标签不应改为折叠）。

## T5 — `+N done` 展开后能收回

按 `design.md` 六(b)：展开态下点击面板空白/正文处即可收起聚合（与 T4 的同一动作合并），
使「点同一处来回切」成立。

**验收**
1. 集成测：折叠态点 `+N done` → 聚合消失、频道各自成标签；
   再点击正文行 → `isFinishedExpanded()` 回到 `false` 或整体折叠（行为需在实现中选定并写进测试名）。
2. 断言不存在「展开后无法收回」的状态：任意时刻都能通过一次点击回到折叠。

## T6 — 文档、文案、changeset

- `docs/{en,zh}/reference/keyboard.md`：把「点击 `+N done` 展开」补全为
  「点击标签切频道；点击面板任意位置展开/折叠；滚轮滚动当前更新且不抢占键盘焦点」。
- `.changeset/*.md`：修订上一轮那条（或新增一条），说明滚轮不再抢焦点、
  点击正文可折叠、修掉 `+N done` 单击无效（双触发）的 bug。**要明确写这是 bug 修复**，
  因为上一轮已发布的 changeset 声称点击可用而实际单击无效。
- `specs/martian-manhunter-hawkman-stature/design.md` 的实测结论已在第六节，无需再改。

**验收**
1. `bun scripts/check-locale-keys.mjs`、`check-t-call-coverage.mjs`、`check-locale-placeholders.cjs` 均 exit 0。
2. changeset 正文包含「不再抢焦点」与「单击无效已修」两项。
3. 中英文档都提到鼠标三种操作。

## T7 — 门禁与部署

**验收**
1. `cd apps/kimi-code && bunx tsc -p tsconfig.json --noEmit` exit 0。
2. `bun --bun run vitest run --project cli` 全绿；`notify-panel.test.ts` 与 `notify.test.ts` 用例数不低于改动前（34 / 42）。
3. `bunx oxlint --quiet` 对改动文件 0 error；`bunx oxfmt --check` 通过。
4. `./tools/review/zig-out/bin/review` 0 error；`bun run check:no-comments` OK。
5. `bun run build && bun run build:native:bun` exit 0；部署后 `sha256sum` 与构建产物一致；
   `~/.kimi-code/bin/kimi --version` 正常；`bun run test:native:smoke` 通过。
