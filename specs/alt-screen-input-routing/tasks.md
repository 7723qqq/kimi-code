# Tasks — 全屏输入路由与恢复

需求见 `requirements.md`（R1–R6），设计见 `design.md`。每条任务的验收断言都**在当前代码上真实失败**，
改完后必须真实通过。

依赖关系：**T1 独立先做**（只改应用层挂载点）；**T2 → T3 → T4 串行**（T2 加 pi-tui 字段，T3 用它收窄消费，
T4 让应用组件声明）；**T5 / T6 / T7 三条互不依赖**，可任意顺序，但 T5 要排在 T2 之后（无逻辑依赖，
仅避免同一文件两次改动）。

全局命令（每个任务的"自测"在此基础上追加）：

```
cd packages/pi-tui && bun test --isolate test/tui-alt-screen.test.ts test/mouse-components.test.ts
cd apps/kimi-code && bun test --isolate test/tui/fullscreen-layout.test.ts test/tui/create-tui-state.test.ts
```

---

## T1 — 常规模式与退出回放重新挂载 status surface（R3）

**文件与符号**

- `apps/kimi-code/src/tui/kimi-tui.ts` → `KimiTUI.buildLayout()`（:1281-1297）、
  `KimiTUI.stopUiForExit()`（:1321-1345）
- 测试加进既有 `apps/kimi-code/test/tui/create-tui-state.test.ts` 与
  `apps/kimi-code/test/tui/kimi-tui-startup.test.ts`（CONVENTIONS: 优先加进既有文件）

**行为改动**
`buildLayout()` 与 `stopUiForExit()` 不再挂 `todoPanelContainer` / `notifyPanelContainer`
（二者从未持有子节点），改挂 `statusSurfaceContainer`（唯一持有 `statusSurface` 的容器）。

**验收断言**（写在 `create-tui-state.test.ts` 的常规模式用例里，对 `buildLayout` 的产物断言）

实际落点：`apps/kimi-code/test/tui/kimi-tui-startup.test.ts` 新增
`mounts the status surface as a root child in regular mode`，跑真实 `driver.init()`
后断言（`buildLayout` 是 private，跑 `init()` 是它的公开触发路径）：

```ts
expect(driver.state.ui.children).toContain(driver.state.statusSurfaceContainer);
expect(driver.state.ui.children).not.toContain(driver.state.todoPanelContainer);
expect(driver.state.ui.children).not.toContain(driver.state.notifyPanelContainer);
```

失败证明：已在修复前用 `git stash` 回退 `kimi-tui.ts` 验证，该用例失败；恢复后通过。

**依赖**：无（第一条）。

---

## T2 — `Component` 增加两个"宿主不得消费"声明（R1/R2 的类型前置）

**文件与符号**

- `packages/pi-tui/src/tui.ts` → `interface Component`（:138-158）
- `packages/pi-tui/src/index.ts` 无需改（`Component` 已导出）

**行为改动**
纯类型扩展，无运行时行为。两个字段语义分离：

```ts
/** Host must not consume pageUp/pageDown/home/end that this component handles itself. */
ownsViewportKeys?: boolean;
/** Host must not consume the transcript-search hotkey while this component holds focus. */
ownsViewportSearchKey?: boolean;
```

**验收断言**
`bunx tsc -p packages/pi-tui/tsconfig.json --noEmit` 通过，且既有 `Component` 实现零改动可编译
（两个字段可选）。这是类型门禁，不是行为断言——T3 才是行为断言。

**依赖**：T1 之后（避免同文件双改；无逻辑依赖）。

---

## T3 — 视口导航键与搜索热键让行（R1 + R2）

**文件与符号**

- `packages/pi-tui/src/tui-alt-screen.ts` → `TuiAltScreen.handleViewportInput()`（:722-851）
- 新增私有判定 `focusedComponentOwnsViewportKeys()` / `focusedComponentWantsSearchKey()`
- 测试加进既有 `packages/pi-tui/test/tui-alt-screen.test.ts`

**行为改动**
1. `tui.altScreen.search`（:781-784）判断前先问 `focusedComponentWantsSearchKey()`；
   为真则不消费该键。
2. **未修饰的**视口导航键（`pageUp/pageDown/halfPageUp/halfPageDown/lineUp/lineDown/top/bottom`）
   按各自的 `matches` 加上 `!focusedOwnsNavigation` 前缀；`previousPrompt`/`nextPrompt`
   保持无条件（见下方执行记录）。
3. `searchNext/searchPrevious/searchClose`（:785-798）**不动**：它们只在搜索 overlay 自己
   聚焦时生效，与本改动不交叉。

**执行记录（与 design.md 的偏差）**

初版把 800-849 整段用一句 `return undefined` 拦掉，结果 `Ctrl-Shift-Up/Down`
（`previousPrompt`/`nextPrompt`）也一并让行，导致 `fullscreen-layout.test.ts` 的三条既有用例
当场变红。这两个修饰键是全屏阅读器专属、编辑器不绑定的能力，让行等于砍掉既有功能。
改为按绑定逐条加前缀后 22 条全绿。design.md 的「让行范围」小节已同步。

**验收断言**（追加两个用例到 `tui-alt-screen.test.ts`）

用例 A：可滚动 transcript + 声明了 `ownsViewportKeys` 的 dock 组件，导航键必须到达组件：

```ts
const pager = {
  focused: false, ownsViewportKeys: true,
  render: () => ["pager"], invalidate: () => {},
  handleInput: (data: string) => inputs.push(data),
};
// transcript 100 行，可滚动
for (const key of ["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F"]) terminal.sendInput(key);
await terminal.waitForRender();
assert.deepStrictEqual(inputs, ["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F"]);
assert.strictEqual(tui.viewportTop, 91); // 视口没有动
```

失败证明：当前 4 个键全部被视口消费（探针实测 `PAGER_RECEIVED []`），`inputs` 为空、`viewportTop` 变化。

用例 B：没声明该字段的 dock 组件仍由视口滚动（防止收窄过度）：

```ts
// 同一个布局，组件不声明 ownsViewportKeys
terminal.sendInput("\x1b[5~");
await terminal.waitForRender();
assert.deepStrictEqual(plain.inputs, []);
assert.ok(tui.viewportTop < before);
```

同时必须保留既有的两个用例绿：`:968`（不可滚动时让行）、`:2065`（overlay 聚焦时让行）。

**依赖**：T2（字段存在）。

---

## T4 — 应用侧组件声明自己拥有视口键（R1/R2 的落地）

**文件与符号**（各加一个字段，不改其他逻辑）

| 文件 | 类 | 声明 |
| --- | --- | --- |
| `apps/kimi-code/src/tui/components/editor/custom-editor.ts` | `CustomEditor` | `ownsViewportKeys = true` |
| `components/dialogs/help-panel.ts` | `HelpPanelComponent` | 两个字段都 `true` |
| `components/dialogs/approval-preview.ts` | `ApprovalPreviewViewer` | 两个字段都 `true` |
| `components/dialogs/tasks-browser.ts` | `TasksBrowserComponent` | 两个字段都 `true` |
| `components/dialogs/trust-prompt.ts` | `TrustPromptComponent` | 两个字段都 `true` |
| `components/dialogs/provider-manager.ts` | `ProviderManagerComponent` | 两个字段都 `true` |

`CustomEditor` **只**声明 `ownsViewportKeys`：它持焦时 `Ctrl-Shift-F` 必须仍然打开 transcript 搜索
（现状功能，不能退化）。这是 design.md 里"两个字段"的理由。

**验收断言**（追加到 `apps/kimi-code/test/tui/fullscreen-layout.test.ts`，它已有真实
`createTUIState` + `VirtualTerminal` 的 `mountFullscreen` 装配）

```ts
// 1) 编辑器在可滚动 transcript 下保住 Home/End
editor.setText("hello world");
terminal.sendInput("\x1b[F");            // End
await terminal.waitForRender();
assert.strictEqual(terminal.getCursorPosition().x, 11);
terminal.sendInput("\x1b[H");            // Home
await terminal.waitForRender();
assert.strictEqual(terminal.getCursorPosition().x, 0);
assert.strictEqual((ui as TuiAltScreen).viewportTop, 0);

// 2) 编辑器持焦时 Ctrl-Shift-F 仍打开搜索
terminal.sendInput("\x1b[102;6u");
await terminal.waitForRender();
assert.ok(terminal.getViewport().some((l) => l.includes("Find in transcript")));
```

失败证明：当前 `End`/`Home` 被视口吃掉，光标的 x 不变（探针实测 `{"x":8}` 不动）。

另加一条已挂载的真实对话框用例（同文件）：`HelpPanelComponent` 装进 `editorContainer`、
transcript 可滚动，发 `PageDown`，断言面板自己的 `scrollTop` 变了、`viewportTop` 没变。

**依赖**：T3（让行逻辑必须已存在，否则声明无效果）。

---

## T5 — 应急恢复补 `?1004l`（R4）

**文件与符号**

- `apps/kimi-code/src/utils/terminal-restore.ts` → `TERMINAL_RESTORE_SEQUENCE`（:21-23）
- 测试新建 `apps/kimi-code/test/utils/terminal-restore.test.ts`（该文件当前不存在，属于
  "对应组件的既有测试文件"缺失，允许新建一个）

**行为改动**
序列在 `?1006l` 之后插入 `?1004l`（与 `tui-alt-screen.ts:68` 的关闭顺序一致）。

**验收断言**

```ts
const writes: string[] = [];
const original = process.stdout.write;
process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as never;
try { restoreTerminalModes(); } finally { process.stdout.write = original; }
const seq = writes.join("");
assert.ok(seq.includes("\u001B[?1004l"), "must disable focus reporting");
assert.ok(seq.indexOf("\u001B[?1049l") < seq.indexOf("\u001B[?1004l"), "leave alt screen first");
assert.ok(seq.includes("\u001B[?25h"), "restore cursor");
```

失败证明：当前序列不含 `?1004l`，第一条断言失败。

**依赖**：无。

---

## T6 — 选中即复制走 verified 剪贴板通路（R5）

**文件与符号**

- `apps/kimi-code/src/tui/tui-state.ts` → `createTUIState()` 的 `new TuiAltScreen(terminal, undefined, undefined, {…})`
  （:147-169），新增 `copySelection`
- 复用 `apps/kimi-code/src/utils/clipboard/clipboard-text.ts` 的 `copyTextToClipboard`
- 测试加进既有 `apps/kimi-code/test/tui/create-tui-state.test.ts`（该文件已断言
  `openUrl`/`onRightClickPaste` 是函数，同处扩展）

**行为改动**
`copySelection(text)` 调用 `copyTextToClipboard`，仅当返回 `'native'` 时解析为 `true`；
抛错解析为 `false`。`TuiAltScreen.copyTextToClipboard`（:1608-1621）据此 flash
`Copied!` / `Copy failed`——不再对 OSC 52-only 的终端谎报成功。

**验收断言**

```ts
const state = createTUIState({ initialAppState: { ...fakeInitialAppState(), tuiMode: 'fullscreen' }, … });
const options = (state.ui as unknown as { copySelection?: (t: string) => Promise<boolean> });
// TuiAltScreen 把它存为私有字段，通过公开方法观测行为：
assert.strictEqual(typeof (state.ui as TuiAltScreen).copyActiveSelectionToClipboard, "function");
```

更强的行为断言（同文件，用 `mock.module` 打桩 `copyTextToClipboard`）：注入 `'osc52'` 返回时，
`copySelection` 结果为 `false`：

```ts
// mock '#/utils/clipboard/clipboard-text' → copyTextToClipboard 返回 'osc52'
const ok = await (state.ui as TuiAltScreen).copyActiveSelectionToClipboard(); // 无选区 → false
```

无选区时该方法恒返回 `false`，无法区分实现。因此行为断言放在 pi-tui 侧已有的
`copySelection` 契约用例上（`tui-alt-screen.test.ts:1464` 已断言"注入 handler 就不写 OSC 52"）——
T6 补充的是**应用确实注入了**，故断言改为对 options 的检查：

```ts
const opts = (state.ui as unknown as { copySelection?: unknown }).copySelection;
assert.strictEqual(typeof opts, "function", "app must inject a verified clipboard path");
```

（`copySelection` 在 `TuiAltScreen` 上是 `private readonly`，测试通过 `as unknown as` 读取；
这是既有测试文件的既有手法，见 `create-tui-state.test.ts:158` 对 `getLayoutRoot()` 的强转。）

**失败证明**：当前 `tui-state.ts` 没传 `copySelection`，字段为 `undefined`，断言失败。

**依赖**：无。

---

## T7 — dock 上限改为每次布局求值（R6）

**文件与符号**

- `packages/pi-tui/src/layout-node.ts` → `StackLayoutEntry.maxSize`（:16）放宽为
  `number | (() => number)`
- `packages/pi-tui/src/components/stack.ts` → `clampSize`（:96-99）、`distribute`（:110-145）
  三处读取点统一走 `resolveMaxSize(entry)`
- `apps/kimi-code/src/tui/tui-state.ts` → `dockContainer.addChild(backgroundTasksMiniContainer, …)`（:251-255）

**行为改动**
`maxSize` 允许传函数；`allocateStackSizes` 每次布局时求值。应用侧改成
`maxSize: () => Math.floor(terminal.rows * 0.5)`。

**验收断言**（加进 `packages/pi-tui/test/` 既有的 stack/vstack 测试文件；
若不存在则加进 `tui-alt-screen.test.ts` 的布局用例）

```ts
// 函数型 maxSize 在每次布局重新求值
let cap = 3;
const stack = new VStack();
stack.addChild(tall, { shrink: 1, minSize: 0, maxSize: () => cap });
const tui = new TuiAltScreen(terminal);
tui.setLayoutRoot(stack);
tui.start();
await terminal.waitForRender();
assert.strictEqual(stack.children.length, 1);
// 断言渲染行数受 cap 限制
const rowsFor = () => /* 布局后该子节点占的行数 */;
assert.strictEqual(rowsFor(), 3);
cap = 6;
tui.requestRender(true);
await terminal.waitForRender();
assert.strictEqual(rowsFor(), 6);   // 关键：旧实现永远是构造时的 3
```

失败证明：当前 `maxSize` 只接受 `number`，传函数时 `normalizeSize` 会把它当 `NaN` 落到
`MAX_SAFE_INTEGER`（`stack.ts:36-38`），断言 `rowsFor() === 3` 失败。

应用侧断言（加进 `create-tui-state.test.ts`）：

```ts
const entry = (state.dockContainer as unknown as { entries: { component: unknown; maxSize: unknown }[] })
  .entries.find((e) => e.component === state.backgroundTasksMiniContainer);
assert.strictEqual(typeof entry.maxSize, "function", "mini panel cap must track terminal.rows");
```

**依赖**：T2 之后（同属 pi-tui 类型改动，避免两次 tsc 循环；无逻辑依赖）。

---

## T8 — 收尾门禁与 changeset

**动作**
1. `bunx tsc -p packages/pi-tui/tsconfig.json --noEmit`
2. `bunx tsc -p apps/kimi-code/tsconfig.json --noEmit`
3. `bun run lint`
4. `bun run check:no-comments`
5. `bun scripts/check-t-call-coverage.mjs`（本轮不新增文案，作为证据）
6. 根 `bun run test`（T2/T3/T7 改了 pi-tui 对外类型，属跨包契约）
7. 写 changeset：两项用户可感知行为
   - `patch`：全屏下对话框/编辑器的 Home、End、PgUp、PgDn 生效
   - `patch`：常规模式恢复 todo/审批/更新栏
   两项一个文件或两个文件按 gen-changesets "One logical change per changeset" 拆成两个。

**验收断言**：以上命令退出码为 0。没有可失败的测试断言——这是门禁，不是行为。

**依赖**：T1–T7 全部完成。
