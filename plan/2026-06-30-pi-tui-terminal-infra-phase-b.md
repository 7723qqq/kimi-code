# Phase B 实施计划：终端层基础设施（能力协商 / resize defer / 输入鲁棒性）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `packages/pi-tui/src/terminal.ts` 升级到 oh-my-pi 的终端层：启动时按 DA1 哨兵 FIFO 探测能力、按 DECRQM 对账私有模式、按终端能力门控同步输出、resize 拖拽借 alt-screen 只画视口、headless 测试模式、以及 stdin-buffer 的鼠标/粘贴鲁棒性。替换 Phase A 在 `terminal-caps-stub.ts` 里的临时桩，给账本引擎提供真实能力数据。

**Architecture:** 改动集中在 `terminal.ts` + 新增 `terminal-capabilities.ts`（能力表/探测/`TERMINAL` 单例）+ `stdin-buffer.ts` + `bracketed-paste.ts`。账本引擎（Phase A）通过注入的 `TerminalCapabilities` 接口消费这些能力，**不**直接依赖 OMP 的 `TERMINAL` 全局。所有探测逻辑 Node-pure（`Bun.env` → `process.env`，`Bun.color` 不需要）。

**Tech Stack:** TypeScript（Node 24）、`node --test`、`@xterm/headless`。`ProcessTerminal` 的能力探测在 headless/非 TTY 下自动跳过，测试用 `VirtualTerminal` + 一个可脚本化回复的 `FakeProbeTerminal`。

**依赖：** Phase A 已完成（账本引擎默认启用）。本阶段替换 Phase A 的 `terminal-caps-stub.ts`。

**前置 deep-dive：** 本计划是**设计级**计划。启动 Phase B 时，应像 Phase A 一样先派 plan agent 逐字提取 `oh-my-pi/packages/tui/src/terminal.ts` 与 `terminal-capabilities.ts` 的关键方法（DA1 FIFO、`#queryPrivateMode`、`#resolvePrivateMode`、`#startOsc11Query`、`#safeWrite` headless、`#renderResizeViewport`），把任务里的伪码替换成逐字移植。

---

## 关键设计决策

1. **能力对象注入，不引全局 `TERMINAL`**：Phase A 的 `LedgerTuiEngine` 目前 import `terminal-caps-stub.ts`。本阶段改为构造时注入 `TerminalCapabilities`（`supportsScreenToScrollback`、`deccara`、`syncEnabled`、`isImageLine`、`imageProtocol`），由 `terminal-capabilities.ts` 提供真实实现。引擎保持可测。
2. **探测在 headless/非 TTY 下全跳过**：`ProcessTerminal.start()` 在 `isTerminalHeadless()` 或 `!isTTY` 时早返回，不发任何探测/不挂 SIGWINCH/不进 raw mode。这是测试不喷帧到开发者终端的关键。
3. **resize defer 接入账本引擎**：Phase A 把几何变化直接走 `fullPaint`。本阶段新增 `#resizeViewportActive` fast path（借 alt-screen 画视口 + 120ms settle），并在 settle 后通过 `requestFullPaint(true)` 触发引擎的权威 fullPaint。
4. **stdin 鲁棒性独立可测**：`StdinBuffer` 的 partial-hold / paste watchdog 是纯逻辑，用假输入源测。

---

## 约定

- **工作目录**：`packages/pi-tui/`。
- **跑测试**：`node --test test/<name>.test.ts`。
- **类型检查**（仓库根）：`pnpm --filter @moonshot-ai/pi-tui typecheck`。
- **提交规范**：`feat(pi-tui):` / `refactor(pi-tui):` / `test(pi-tui):`；无 co-author；无 claude。

---

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/terminal-capabilities.ts` | 新建 | `TerminalCapabilities` 接口、`ProcessTerminalCapabilities`（能力表 + 探测结果）、`shouldEnableSyncOutput`、`TERMINAL_ID` |
| `src/terminal-probe.ts` | 新建 | DA1 哨兵 FIFO、`probeCapabilities`（kitty/OSC11/DECRQM/OSC99） |
| `src/terminal.ts` | 修改 | `ProcessTerminal`：headless 模式、接入探测、resize defer、`syncBegin/syncEnd`（真实）、ConPTY 分块 |
| `src/stdin-buffer.ts` | 修改 | partial-hold（SGR 鼠标/转义）、paste watchdog |
| `src/bracketed-paste.ts` | 新建 | `decodeReencodedPasteControls`（tmux csi-u + xterm 双变体） |
| `src/ledger/terminal-caps-stub.ts` | 修改/删除 | 桩替换为真实能力注入（或删除，改 import `terminal-capabilities.ts`） |
| `src/ledger/engine.ts` | 修改 | 构造时接收 `TerminalCapabilities`；resize defer fast path |
| `test/terminal-capabilities.test.ts` | 新建 | 能力表/env 覆盖/门控 |
| `test/terminal-probe.test.ts` | 新建 | DA1 FIFO 排序、DECRQM 解析 |
| `test/terminal-headless.test.ts` | 新建 | headless 不发探测/不喷帧 |
| `test/resize-defer.test.ts` | 新建 | resize 拖拽 alt-screen + settle |
| `test/stdin-buffer-partial.test.ts` | 新建 | 鼠标/转义 partial-hold、paste watchdog |
| `test/bracketed-paste.test.ts` | 新建 | tmux 双变体解码 |

---

## Task 1: 真实能力表 + 同步输出门控（替换 Phase A 桩）

**Files:**
- Create: `packages/pi-tui/src/terminal-capabilities.ts`
- Create: `packages/pi-tui/test/terminal-capabilities.test.ts`
- Modify: `packages/pi-tui/src/ledger/engine.ts`（构造接收能力对象）

### Step 1: 写 `TerminalCapabilities` 接口 + 静态表

```ts
export type ImageProtocol = "kitty" | "sixel" | "iterm2" | "none";

export interface TerminalCapabilities {
	readonly syncEnabled: boolean;
	readonly supportsScreenToScrollback: boolean;
	readonly deccara: boolean;
	readonly hyperlinks: boolean;
	readonly imageProtocol: ImageProtocol;
	isImageLine(line: string): boolean;
}

const SYNC_KNOWN = ["xterm-kitty", "xterm-ghostty", "wezterm", "alacritty", "foot", "contour", "kitty", "ghostty"];

export function isMultiplexerSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["TMUX"] || env["STY"] || env["ZELLIJ"] || env["CMUX_WORKSPACE_ID"] || env["CMUX_SURFACE_ID"]) return true;
	const term = (env["TERM"] ?? "").toLowerCase();
	return term.startsWith("tmux") || term.startsWith("screen");
}

export function shouldEnableSyncOutput(env: NodeJS.ProcessEnv = process.env, detected?: boolean): boolean {
	if (env["PI_FORCE_SYNC_OUTPUT"] === "1") return true;
	if (env["PI_NO_SYNC_OUTPUT"] === "1") return false;
	if (typeof detected === "boolean") return detected; // DECRQM 运行时结果优先
	if (isMultiplexerSession(env)) return false;
	const term = env["TERM"] ?? "";
	return SYNC_KNOWN.some((k) => term.includes(k));
}

export function shouldEnableHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["PI_NO_HYPERLINKS"] === "1") return false;
	// tmux < 3.4 对 OSC 8 支持不稳；简化：mux 下默认关
	if (isMultiplexerSession(env)) return false;
	return true;
}
```

### Step 2: 写测试 `test/terminal-capabilities.test.ts`

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { isMultiplexerSession, shouldEnableSyncOutput, shouldEnableHyperlinks } from "../src/terminal-capabilities.ts";

describe("terminal-capabilities", () => {
	it("detects mux via env and TERM fallback", () => {
		assert.strictEqual(isMultiplexerSession({ TMUX: "x" }), true);
		assert.strictEqual(isMultiplexerSession({ TERM: "screen-256color" }), true);
		assert.strictEqual(isMultiplexerSession({ TERM: "xterm-256color" }), false);
	});
	it("sync: force on overrides mux", () => {
		assert.strictEqual(shouldEnableSyncOutput({ PI_FORCE_SYNC_OUTPUT: "1", TMUX: "x" }), true);
	});
	it("sync: off in mux by default", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TMUX: "x", TERM: "xterm-kitty" }), false);
	});
	it("sync: on for known direct terminal", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "xterm-kitty" }), true);
	});
	it("sync: DECRQM result overrides static table", () => {
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "dumb" }, true), true);
		assert.strictEqual(shouldEnableSyncOutput({ TERM: "xterm-kitty" }, false), false);
	});
	it("hyperlinks off in mux", () => {
		assert.strictEqual(shouldEnableHyperlinks({ TMUX: "x" }), false);
	});
});
```

Run: `node --test test/terminal-capabilities.test.ts` → 通过。

### Step 3: 让 `LedgerTuiEngine` 构造时接收 `TerminalCapabilities`

把 `engine.ts` 构造器改为：

```ts
import type { TerminalCapabilities } from "../terminal-capabilities.ts";

constructor(
	private readonly terminal: Terminal,
	private readonly getChildren: () => Component[],
	private readonly caps: TerminalCapabilities,
) {
	this.#syncEnabled = caps.syncEnabled;
	// ... paintBegin/End 用 caps.syncEnabled
}
```

把 `#terminalLine`/`#prepareLine` 里的 `isImageLine` 调用改为 `caps.isImageLine(...)`；`#emitFullPaint` 的 ED22 分支改为 `if (this.caps.supportsScreenToScrollback) buffer += "\x1b[22J";`。

`tui.ts` 的 `getLedgerEngine()` 改为传入一个默认的 `TerminalCapabilities`（Phase B Task 2 之前先用静态表构造一个 `ProcessTerminalCapabilities` 的静态实例；Task 2 之后换成探测结果）。

### Step 4: 提交

```bash
git add packages/pi-tui/src/terminal-capabilities.ts packages/pi-tui/src/ledger/engine.ts packages/pi-tui/test/terminal-capabilities.test.ts
git commit -m "feat(pi-tui): add terminal capability table and inject into ledger engine"
```

---

## Task 2: DA1 哨兵探测 FIFO + DECRQM 对账

**Files:**
- Create: `packages/pi-tui/src/terminal-probe.ts`
- Create: `packages/pi-tui/test/terminal-probe.test.ts`
- Modify: `packages/pi-tui/src/terminal.ts`

### Step 1: 写 `terminal-probe.ts`（DA1 哨兵 FIFO）

> 机制：每个探测发完查询紧跟 `CSI c`（DA1）。终端按序处理，哪个回复先到就 resolve 哪个探测——保证不死等、探测字节不漏进编辑器。详见 OMP `terminal.ts:360-365, 752-794`。

```ts
export interface ProbeResult {
	kittyKeyboard: boolean;
	syncOutput: boolean | undefined; // DECRQM ?2026
	inBandResize: boolean | undefined; // DECRQM ?2048
	appearancePush: boolean | undefined; // DECRQM ?2031
	background: { r: number; g: number; b: number } | undefined;
}

export interface ProbeIO {
	write(data: string): void;
	onReply(cb: (data: string) => void): () => void; // returns unsubscribe
}

/** 串行跑所有启动探测；任一探测 300ms 超时则跳过。 */
export async function probeCapabilities(io: ProbeIO, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
	const timeoutMs = opts.timeoutMs ?? 300;
	// TODO(Phase B 启动时逐字移植 OMP 的 Da1SentinelOwner 队列)：
	// 1. 依次发：kitty keyboard query + DA1、OSC 11 bg + DA1、DECRQM ?2026/?2048/?2031 + DA1、OSC 99 + DA1
	// 2. 一个 reply 收集器按 DA1 哨兵把字节路由到对应 probe 的 resolve
	// 3. 每个 probe 独立 timeoutMs 超时
	// 这里先给出骨架 + 测试契约；实现时替换为 OMP 逐字代码。
	throw new Error("probeCapabilities: implement during Phase B execution from OMP terminal.ts verbatim");
}
```

### Step 2: 写测试 `test/terminal-probe.test.ts`（用一个可脚本回复的 FakeProbeIO）

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
// import { probeCapabilities } from "../src/terminal-probe.ts";

describe("probeCapabilities (DA1 FIFO)", () => {
	it("resolves each probe when its DA1 sentinel returns, in order", async () => {
		// TODO Phase B: FakeProbeIO 记录写入，按顺序回放 kitty/DA1、OSC11/DA1、DECRQM/DA1 回复，
		// 断言每个 probe 在 300ms 内 resolve、字段正确。
		assert.ok(true, "scaffold");
	});
	it("times out a probe that the terminal ignores without hanging others", async () => {
		// TODO Phase B: 只回放 kitty 回复，不回放 DECRQM；断言 syncOutput 为 undefined 且整体不超 ~350ms。
		assert.ok(true, "scaffold");
	});
});
```

> 注：本任务在 Phase B 启动 deep-dive 后填充真实实现与测试。骨架先占位以便类型/接口对齐。

### Step 3: `ProcessTerminal` 接入探测

在 `ProcessTerminal.start()` 里（非 headless 时）调用 `probeCapabilities`，把结果写入一个 `ProcessTerminalCapabilities` 实例，并据 `syncOutput`（DECRQM 结果）更新 `syncBegin/syncEnd`。

### Step 4: 提交

```bash
git add packages/pi-tui/src/terminal-probe.ts packages/pi-tui/src/terminal.ts packages/pi-tui/test/terminal-probe.test.ts
git commit -m "feat(pi-tui): probe terminal capabilities via DA1 sentinel FIFO"
```

---

## Task 3: Headless 测试模式

**Files:**
- Modify: `packages/pi-tui/src/terminal.ts`
- Create: `packages/pi-tui/test/terminal-headless.test.ts`

### Step 1: 在 `terminal.ts` 新增 headless 判定

```ts
let headlessOverride: boolean | undefined;

export function setTerminalHeadless(value: boolean | undefined): void {
	headlessOverride = value;
}

export function isTerminalHeadless(): boolean {
	if (headlessOverride !== undefined) return headlessOverride;
	// node --test / bun test 下默认 headless；PI_TUI_HEADLESS=1 强制
	if (process.env["PI_TUI_HEADLESS"] === "1") return true;
	if (process.env["NODE_ENV"] === "test") return true;
	return false;
}
```

### Step 2: `ProcessTerminal.start()` / `#safeWrite` 接入

```ts
// ProcessTerminal.start()
start(onInput, onResize) {
	if (isTerminalHeadless() || !process.stdout.isTTY) {
		// headless：不进 raw mode、不发探测、不挂 SIGWINCH、不写 teardown
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		return;
	}
	// ... 原有逻辑
}

// #safeWrite 包装所有 process.stdout.write：
#safeWrite(data: string): void {
	if (isTerminalHeadless()) return;
	process.stdout.write(data);
}
```

把 `ProcessTerminal` 里所有 `process.stdout.write(...)` 替换为 `this.#safeWrite(...)`。

### Step 3: 写测试 `test/terminal-headless.test.ts`

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal, setTerminalHeadless } from "../src/terminal.ts";

describe("ProcessTerminal headless", () => {
	it("does not write probes or frames when headless", () => {
		setTerminalHeadless(true);
		try {
			const term = new ProcessTerminal();
			const writes: string[] = [];
			const orig = process.stdout.write;
			(process.stdout as unknown as { write: (d: string) => boolean }).write = (d: string) => {
				writes.push(d);
				return true;
			};
			term.start(() => {}, () => {});
			term.write("\x1b[?2026h");
			term.stop();
			(process.stdout as unknown as { write: typeof orig }).write = orig;
			assert.strictEqual(writes.length, 0, `headless must not write: ${writes.join("|")}`);
		} finally {
			setTerminalHeadless(undefined);
		}
	});
});
```

Run: `node --test test/terminal-headless.test.ts` → 通过。

### Step 4: 提交

```bash
git add packages/pi-tui/src/terminal.ts packages/pi-tui/test/terminal-headless.test.ts
git commit -m "feat(pi-tui): add headless terminal mode to keep tests from painting"
```

---

## Task 4: Resize viewport defer（接入账本引擎）

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`
- Modify: `packages/pi-tui/src/tui.ts`（SIGWINCH 回调）
- Create: `packages/pi-tui/test/resize-defer.test.ts`

### Step 1: 在 `LedgerTuiEngine` 新增 resize defer 字段 + 方法（OMP: 3249-3295）

```ts
	#resizeViewportActive = false;
	#resizeViewportSettleTimer: ReturnType<typeof setTimeout> | undefined;
	#resizeAltActive = false;
	#resizeViewportPaintCount = 0;
	static readonly #RESIZE_SETTLE_MS = 120;

	// 由 TUI 的 SIGWINCH 回调调用（非 mux）
	public beginResizeViewport(): void {
		if (isMultiplexerSession()) return; // mux 不走 alt-screen
		if (!this.#resizeViewportActive) {
			this.terminal.write("\x1b[?1049h");
			this.#resizeViewportActive = true;
			this.#resizeAltActive = true;
		}
		this.#armResizeSettle();
	}

	#armResizeSettle(): void {
		if (this.#resizeViewportSettleTimer) clearTimeout(this.#resizeViewportSettleTimer);
		this.#resizeViewportSettleTimer = setTimeout(() => this.#settleResizeViewport(), LedgerTuiEngine.#RESIZE_SETTLE_MS);
	}

	#settleResizeViewport(): void {
		this.#resizeViewportSettleTimer = undefined;
		if (this.#resizeViewportActive) {
			this.#resizeViewportActive = false;
			this.#resizeAltActive = false;
			this.terminal.write("\x1b[?1049l");
		}
		// settle 后一次权威 fullPaint（清 scrollback，rewrap）
		this.requestFullPaint(true);
		this.doRender();
	}

	// 视口 fast path：只画底部 height 行到 alt-screen，不推进 ledger
	#renderResizeViewport(width: number, height: number): void {
		const rawFrame = this.#composeFrame(width);
		const frame = this.#prepareFrame(rawFrame, width);
		const start = Math.max(0, frame.length - height);
		let buffer = this.#paintBeginSequence + "\x1b[H";
		for (let r = 0; r < height; r++) {
			if (r > 0) buffer += "\r\n";
			buffer += "\x1b[2K" + this.#terminalLine(frame[start + r] ?? "");
		}
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#resizeViewportPaintCount += 1;
	}
```

### Step 2: 在 `doRender()` 顶部加 fast-path 短路（OMP: 2536-2545）

```ts
	public doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		if (this.#resizeViewportActive) {
			// 拖拽中：只画视口，不推进 ledger/commit/diff
			this.#renderResizeViewport(width, height);
			this.#armResizeSettle();
			return;
		}
		// ... 原有分类器主体
	}
```

### Step 3: TUI 的 SIGWINCH 回调接入

在 TUI 的终端 `onResize` 回调里：

```ts
this.ledgerEngine?.notifyResize();
if (!isMultiplexerSession()) this.ledgerEngine?.beginResizeViewport();
```

（mux 下只 `notifyResize()`，由分类器的 `geometryChanged` 触发 mux 安全路径。）

### Step 4: 写测试 `test/resize-defer.test.ts`

断言：连续 `terminal.resize(...)` 中不写 `\x1b[3J`、写 `\x1b[?1049h`；settle（等 150ms）后写 `\x1b[?1049l` 且 `fullRedraws` 增加；mux env 下不写 `\x1b[?1049h`。

Run: `node --test test/resize-defer.test.ts` → 通过。

### Step 5: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts packages/pi-tui/src/tui.ts packages/pi-tui/test/resize-defer.test.ts
git commit -m "feat(pi-tui): defer authoritative repaint during resize drags"
```

---

## Task 5: 输入鲁棒性（stdin-buffer partial-hold + paste watchdog + bracketed-paste）

**Files:**
- Create: `packages/pi-tui/src/bracketed-paste.ts`
- Modify: `packages/pi-tui/src/stdin-buffer.ts`
- Create: `packages/pi-tui/test/bracketed-paste.test.ts`
- Create: `packages/pi-tui/test/stdin-buffer-partial.test.ts`

### Step 1: 写 `bracketed-paste.ts`（OMP: bracketed-paste.ts:37-41）

```ts
// 解 tmux extended-keys-format 的 csi-u 和 xterm 两种变体，回到字面控制字节
const CSI_U = /\x1b\[(\d+);(\d+)u/g;
const XTERM_MOD = /\x1b\[27;(\d+);(\d+)~/g;

export function decodeReencodedPasteControls(text: string): string {
	// csi-u: ESC [ code ; mod u
	text = text.replace(CSI_U, (_m, code) => String.fromCharCode(Number(code)));
	// xterm modifyOtherKeys: ESC [ 27 ; mod ; code ~
	text = text.replace(XTERM_MOD, (_m, _mod, code) => String.fromCharCode(Number(code)));
	return text;
}
```

### Step 2: 测试 `test/bracketed-paste.test.ts`

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { decodeReencodedPasteControls } from "../src/bracketed-paste.ts";

describe("decodeReencodedPasteControls", () => {
	it("decodes csi-u Ctrl+J", () => {
		assert.strictEqual(decodeReencodedPasteControls("\x1b[106;5u"), "\n");
	});
	it("decodes xterm modifyOtherKeys Ctrl+J", () => {
		assert.strictEqual(decodeReencodedPasteControls("\x1b[27;5;106~"), "\n");
	});
	it("leaves plain text unchanged", () => {
		assert.strictEqual(decodeReencodedPasteControls("hello"), "hello");
	});
});
```

### Step 3: `stdin-buffer.ts` 加 partial-hold + paste watchdog

> OMP `stdin-buffer.ts:471-599`：把"无歧义的部分序列"（SGR 鼠标前缀 `ESC [<…`、kitty 激活时的悬挂转义）hold 到 `PARTIAL_HOLD_MAX_MS=150` 再 flush；粘贴 inactivity watchdog（1000ms）+ 64 MiB 上限 + `#abortPaste`。

具体移植在 Phase B 启动 deep-dive 时逐字对照；测试覆盖：
- `[<35;8;16M` 分两次到达 → 最终作为一次 SGR 鼠标事件，不漏文本。
- 悬挂 `ESC[` 在 kitty 激活时 hold 150ms 后 flush。
- 粘贴 1000ms 无结束符 → abortPaste 恢复，不挂起。

### Step 4: 提交

```bash
git add packages/pi-tui/src/bracketed-paste.ts packages/pi-tui/src/stdin-buffer.ts packages/pi-tui/test/bracketed-paste.test.ts packages/pi-tui/test/stdin-buffer-partial.test.ts
git commit -m "fix(pi-tui): harden stdin buffering against split mouse/escape and paste stalls"
```

---

## Task 6: 端到端接线 + 全量验证

### Step 1: 跑全量测试

Run: `node --test test/*.test.ts`
Expected: 全绿（含 Phase A 的 ledger stress）。

### Step 2: 类型检查

Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 通过。

### Step 3: 手动验证

启动 CLI（默认 ledger + 真实能力探测）：
- 在 kitty 下确认同步输出开启（无闪烁）。
- 在 tmux 下确认 resize 不 ED3 清 pane scrollback。
- 跑 `bun test`/`pnpm test` 在交互终端不喷帧（headless）。

### Step 4: 提交（如有收尾修改）

```bash
git commit -m "chore(pi-tui): wire terminal infrastructure end-to-end"
```

---

## 验收总清单

- [ ] 能力探测在 kitty 下拿到 sync/DECRQM 结果；在忽略探测的终端上 300ms 内超时跳过。
- [ ] headless 下 `ProcessTerminal` 不写任何字节。
- [ ] resize 拖拽不写 `\x1b[3J`，settle 后一次权威重排。
- [ ] tmux 下 resize 不借 alt-screen。
- [ ] stdin 分片鼠标/转义不漏文本；粘贴 watchdog 不挂起。
- [ ] Phase A 的 ledger stress 仍全绿（回归）。
- [ ] 全量测试 + 类型检查通过。

---

## Self-Review

**1. 覆盖：** 能力协商（Task 1-2）、headless（Task 3）、resize defer（Task 4）、输入鲁棒性（Task 5）、端到端（Task 6）。覆盖 Agent B 报告的高价值项（DA1 FIFO、DECRQM、headless、partial-hold、paste watchdog、tmux paste 双变体、resize defer）。

**2. 占位：** Task 2 的 `probeCapabilities` 标注了 `TODO(Phase B 启动时逐字移植)`——这是**有意的 scaffold**，因为本计划是设计级，真实实现需 Phase B 启动时 deep-read `terminal.ts`。这不是"留空等以后"，而是明确的执行入口。

**3. 一致性：** `TerminalCapabilities` 接口在 Task 1 定义、Task 1 engine 构造接收、Task 2 `ProcessTerminalCapabilities` 实现，一致。`isMultiplexerSession` 从 `terminal-caps-stub.ts` 迁移到 `terminal-capabilities.ts`，engine import 路径同步更新。

**4. 风险：** DA1 FIFO 是最微妙的一块（多终端回复排序），必须在 Phase B 启动时逐字移植 OMP，不能凭记忆写。resize defer 与 app 全屏接管的交互已在 Phase A 计划 Task 6 的 bug 修复里处理（`requestRender(true)` 绕过 defer）。
