# Phase A 实施计划：pi-tui 渲染器账本核心（1:1 对齐 oh-my-pi）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `packages/pi-tui/src/tui.ts` 的渲染核心从"上一帧 diff + 散落的 fullRender"替换为 oh-my-pi 的**追加式 native scrollback 账本引擎**（ledger + seam + 范围感知审计 + render intent 分类器 + `#emitFullPaint`/`#emitUpdate` 三形态），Node-pure，**只动 pi-tui 包内部**，不碰 app 层。

**Architecture:** 新引擎与旧引擎**并存于一个开关之后**（`PI_TUI_ENGINE=ledger`），旧 `doRender` 保留为回退。新引擎由独立的 `#doRenderLedger()` 驱动，使用新增的 `#composeFrame()`（段式合成，不覆盖 `Container.render`）。每个任务用 `node --test` + `@xterm/headless` 的 `VirtualTerminal` 验证；最后用 render-stress（VT oracle + 种子化随机）做总验收，绿了再切默认。

**Tech Stack:** TypeScript（Node 24 type-stripping）、`node --test`、`@xterm/headless`、`node:assert`。纯 TS，**不引入 Bun / pi-natives / pi-utils**。

**参考实现（faithful 来源）：** `oh-my-pi/packages/tui/src/tui.ts`（3695 行）。本计划每项都标注对应的 OMP 行号，便于逐行对照移植。

---

## 关键设计决策（先读，决定计划形状）

1. **并存开关，不大爆炸替换**：新增 `#doRenderLedger()`，由 `doRender()` 按 `process.env["PI_TUI_ENGINE"] === "ledger"` 分发。旧逻辑（`#doRenderLegacy()`）完整保留。这样每个任务都可独立测试，出问题可立即回退。**最后任务**才切默认并删旧代码。
2. **不覆盖 `Container.render`**：OMP 是 `override render()` 做段式合成。我们为保持旧引擎独立，新增私有 `#composeFrame(width): readonly string[]`（逻辑等同 OMP 的 `render()` override），旧引擎继续用继承的 `render()`。
3. **Phase A 范围内降级/桩掉的部分**（明确取舍，后续 Phase 补）：
   - **Overlay**：我们的 app 不用 `TUI.showOverlay`，新引擎硬编码 `hasVisibleOverlay = false`，不移植 `#compositeOverlaysIntoWindow`。
   - **图像**：`ImageBudget` 用 no-op 桩（`beginPass/endPass/takeTransmits/takePurgeIds` 返回空）；`isImageLine` 复用我们 `src/terminal-image.ts` 的现有函数；`#emitFullPaint` 的 `imageTransmitBuffer`/`purgeSequence` 传空串。
   - **DECCARA**：`#deccaraFillsEnabled()` 返回 `false`（`planDeccaraFills` 用「原样返回 window」的桩）。
   - **终端能力**：`TERMINAL.supportsScreenToScrollback` → `false`（不用 kitty ED22）；`TERMINAL.deccara` → `false`；`TERMINAL.isImageLine` → 我们的 `isImageLine`；同步输出用 Task 1 的简单门控。
   - **resize viewport drag fast path**：`#resizeViewportActive` 的 alt-screen 拖拽优化**放到 Phase B**。Phase A 里几何变化直接走 `fullPaint`（和我们现在一样，但经新分类器）。只移植 `isMultiplexerSession` / `resizeRepaintsInPlace`（分类器要）。
4. **宽度/截断函数复用我们的 `utils.ts`**：`visibleWidth` / `truncateToWidth` / `sliceByColumn` / `wrapTextWithAnsi` 已存在；`normalizeTerminalOutput` 如缺则补一个最小等价（去 OSC 以外的非法控制字符）。
5. **硬件光标**：移植 `#cursorControlSequence` + `#targetHardwareCursorState` 的简化版，复用我们现有的 `positionHardwareCursor` 思路但接入新 emitter。
6. **审计/账本严格 faithful**：`findCommittedPrefixResync` 逐字移植（`export` 出来供 stress 用）；三 zones（`auditRows ≤ durableRows ≤ committedRows`）不变量严格保持。

---

## 约定

- **工作目录**：所有命令在 `packages/pi-tui/` 下执行。
- **跑单个测试**：`node --test test/<name>.test.ts`
- **跑全量测试**：`node --test test/*.test.ts`
- **类型检查**（仓库根）：`pnpm --filter @moonshot-ai/pi-tui typecheck`
- **测试模式**：复用 `test/virtual-terminal.ts` 的 `VirtualTerminal`（`getViewport`/`getScrollBuffer`/`resize`/`waitForRender`）；Task 1 新增 `LoggingVirtualTerminal`（捕获 emit 字节）。
- **新引擎默认关**：除 Task 10（stress）和 Task 11（切默认）外，所有新测试通过 `withEnv({ PI_TUI_ENGINE: "ledger" }, …)` 显式打开。
- **提交规范**：语义化提交 `feat(pi-tui):` / `refactor(pi-tui):` / `test(pi-tui):`；**不要** co-author；**不要**出现 claude 字样。
- **忠实度**：每个核心函数后标注 `// OMP: <lines>`，便于对照 `oh-my-pi/packages/tui/src/tui.ts`。

---

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/ledger/types.ts` | 新建 | `RenderIntent`、`FrameSegment`、`PreparedLine`、cursor 类型、`SGR_SEQUENCE`、常量 |
| `src/ledger/seam.ts` | 新建 | `NativeScrollbackLiveRegion` / `NativeScrollbackCommittedRows` / `RenderStablePrefix` 接口 + getter |
| `src/ledger/sgr-coalesce.ts` | 新建 | `coalesceAdjacentSgr` + `endsWithIncompleteExtendedColor`（逐字移植） |
| `src/ledger/audit.ts` | 新建 | `findCommittedPrefixResync`（export）+ `rowsEquivalent`/`isBlankRow` |
| `src/ledger/engine.ts` | 新建 | `LedgerTuiEngine` 类：ledger 字段、`#composeFrame`、`#prepareFrame`、`#terminalLine`、`#lineRewriteSequence`、`#auditCommittedPrefix`、`#updateCommittedAuditRows`、`#commit`、`#emitFullPaint`、`#emitUpdate`、`#doRenderLedger` |
| `src/ledger/terminal-caps-stub.ts` | 新建 | Phase A 桩：`isMultiplexerSession`、`resizeRepaintsInPlace`、`TERMINAL` 能力桩、sync 门控 |
| `src/tui.ts` | 修改 | `doRender()` 改为按 `PI_TUI_ENGINE` 分发；旧逻辑改名 `#doRenderLegacy()`；注入 `LedgerTuiEngine` |
| `test/virtual-terminal.ts` | 修改 | 追加 `LoggingVirtualTerminal` |
| `test/ledger-sgr-coalesce.test.ts` | 新建 | SGR 合并单元测试 |
| `test/ledger-audit.test.ts` | 新建 | `findCommittedPrefixResync` 单元测试 |
| `test/ledger-engine-golden.test.ts` | 新建 | 新引擎 golden：基础/流式追加/收缩/超宽 clamp |
| `test/ledger-engine-stress.test.ts` | 新建 | render-stress：VT oracle + 种子化随机 |

> **为什么拆 `src/ledger/` 子目录**：新引擎逻辑集中、可独立测试，且与旧 `tui.ts` 解耦；切默认后旧 `#doRenderLegacy()` 删除，`LedgerTuiEngine` 可再内联回 `tui.ts`（Task 11 决定）。

---

## Task 1: 基础类型 + seam 接口 + SGR 合并 + 能力桩

**Files:**
- Create: `packages/pi-tui/src/ledger/types.ts`
- Create: `packages/pi-tui/src/ledger/seam.ts`
- Create: `packages/pi-tui/src/ledger/sgr-coalesce.ts`
- Create: `packages/pi-tui/src/ledger/terminal-caps-stub.ts`
- Modify: `packages/pi-tui/test/virtual-terminal.ts`
- Create: `packages/pi-tui/test/ledger-sgr-coalesce.test.ts`

### Step 1: 写 `src/ledger/types.ts`（OMP: 40-85, 603-657）

```ts
import type { Component } from "../tui.ts";

export const SEGMENT_RESET = "\x1b[0m";
export const LINE_TERMINATOR = "\x1b[0m\x1b]8;;\x07";
export const ERASE_LINE = "\x1b[2K";
export const ERASE_TO_END_OF_LINE = "\x1b[K";
export const HIDE_CURSOR = "\x1b[?25l";
export const SYNC_OUTPUT_BEGIN = "\x1b[?2026h";
export const SYNC_OUTPUT_END = "\x1b[?2026l";
export const DISABLE_AUTOWRAP = "\x1b[?7l";
export const ENABLE_AUTOWRAP = "\x1b[?7h";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_EXIT = "\x1b[?1049l";

export const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;
export const MERGE_TOKEN_CAP = 16;

export type RenderIntent =
	| { kind: "fullPaint"; clearScrollback: boolean }
	| { kind: "update"; chunkTo: number; windowTop: number };

export interface HardwareCursorState {
	row: number;
	col: number;
	visible: boolean;
}

export interface HardwareCursorUpdate {
	toRow: number;
	state: HardwareCursorState | null;
	visible?: boolean;
}

export interface CursorControlResult extends HardwareCursorUpdate {
	seq: string;
	toCol: number;
	visible: boolean;
}

export interface FrameSegment {
	component: Component;
	lines: readonly string[];
	start: number;
	rowCount: number;
	liveLocalStart?: number;
	commitLocalEnd?: number;
	snapshotLocalEnd?: number;
}

export interface PreparedLine {
	raw: string;
	width: number;
	line: string;
}
```

### Step 2: 写 `src/ledger/seam.ts`（OMP: 184-278）

```ts
import type { Component } from "../tui.ts";

export interface NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined;
	getNativeScrollbackCommitSafeEnd?(): number | undefined;
	getNativeScrollbackSnapshotSafeEnd?(): number | undefined;
}

export interface NativeScrollbackCommittedRows {
	setNativeScrollbackCommittedRows(rows: number): void;
}

export interface RenderStablePrefix {
	getRenderStablePrefixRows(): number;
}

export function getNativeScrollbackLiveRegionStart(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackLiveRegionStart?.();
}

export function getNativeScrollbackCommitSafeEnd(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackCommitSafeEnd?.();
}

export function getNativeScrollbackSnapshotSafeEnd(component: Component): number | undefined {
	return (component as Component & Partial<NativeScrollbackLiveRegion>).getNativeScrollbackSnapshotSafeEnd?.();
}

export function setNativeScrollbackCommittedRows(component: Component, rows: number): void {
	(component as Component & Partial<NativeScrollbackCommittedRows>).setNativeScrollbackCommittedRows?.(rows);
}

export function getRenderStablePrefixRows(component: Component): number | undefined {
	return (component as Component & Partial<RenderStablePrefix>).getRenderStablePrefixRows?.();
}
```

### Step 3: 写失败的 SGR 合并测试 `test/ledger-sgr-coalesce.test.ts`

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { coalesceAdjacentSgr } from "../src/ledger/sgr-coalesce.ts";

describe("coalesceAdjacentSgr (ledger)", () => {
	it("merges byte-adjacent SGR into one CSI", () => {
		assert.strictEqual(coalesceAdjacentSgr("\x1b[39m\x1b[38;2;1;2;3mX"), "\x1b[39;38;2;1;2;3mX");
	});
	it("keeps non-adjacent SGR separate", () => {
		assert.strictEqual(coalesceAdjacentSgr("\x1b[31mA\x1b[32mB"), "\x1b[31mA\x1b[32mB");
	});
	it("splits runs over the 16-token cap", () => {
		const run = Array.from({ length: 20 }, () => "\x1b[1m").join("");
		const out = coalesceAdjacentSgr(`${run}X`);
		assert.ok((out.match(/\x1b\[/g) ?? []).length >= 2);
	});
	it("does not merge across incomplete extended color", () => {
		const out = coalesceAdjacentSgr("\x1b[38;2m\x1b[1mX");
		assert.ok(out.includes("\x1b[38;2m\x1b[1m"), JSON.stringify(out));
	});
	it("returns plain text unchanged (same reference not required)", () => {
		assert.strictEqual(coalesceAdjacentSgr("hello"), "hello");
	});
});
```

Run: `node --test test/ledger-sgr-coalesce.test.ts` → 应失败（模块不存在）。

### Step 4: 写 `src/ledger/sgr-coalesce.ts`（OMP: 659-792，逐字移植，`Bun`→无）

```ts
import { MERGE_TOKEN_CAP } from "./types.ts";

const SGR_COALESCE_ENABLED = process.env["PI_NO_SGR_COALESCE"] !== "1";
const CC_ESC = 0x1b;
const CC_BRACKET = 0x5b;
const CC_M = 0x6d;
const CC_SEMI = 0x3b;
const CC_COLON = 0x3a;

function isSgrParamByte(c: number): boolean {
	return (c >= 0x30 && c <= 0x39) || c === CC_SEMI || c === CC_COLON;
}

// OMP: 687-717
function endsWithIncompleteExtendedColor(params: string): boolean {
	const t = params.split(";");
	let i = 0;
	while (i < t.length) {
		const tok = t[i];
		if (tok === "38" || tok === "48" || tok === "58") {
			const mode = t[i + 1];
			if (mode === undefined) return true;
			if (mode === "2") {
				if (i + 4 >= t.length) return true;
				i += 5;
				continue;
			}
			if (mode === "5") {
				if (i + 2 >= t.length) return true;
				i += 3;
				continue;
			}
		}
		i += 1;
	}
	return false;
}

// OMP: 719-792
export function coalesceAdjacentSgr(line: string): string {
	if (!SGR_COALESCE_ENABLED || line.indexOf("\x1b[") === -1) return line;
	const n = line.length;
	let out = "";
	let copiedUpto = 0;
	let i = 0;
	while (i < n) {
		if (line.charCodeAt(i) !== CC_ESC || line.charCodeAt(i + 1) !== CC_BRACKET) {
			i++;
			continue;
		}
		let j = i + 2;
		while (j < n && isSgrParamByte(line.charCodeAt(j))) j++;
		if (j >= n || line.charCodeAt(j) !== CC_M) {
			i = j;
			continue;
		}
		const params: string[] = [line.slice(i + 2, j)];
		let k = j + 1;
		while (k < n && line.charCodeAt(k) === CC_ESC && line.charCodeAt(k + 1) === CC_BRACKET) {
			let p = k + 2;
			while (p < n && isSgrParamByte(line.charCodeAt(p))) p++;
			if (p >= n || line.charCodeAt(p) !== CC_M) break;
			params.push(line.slice(k + 2, p));
			k = p + 1;
		}
		if (params.length > 1) {
			out += line.slice(copiedUpto, i);
			let group = "";
			let groupTokens = 0;
			let groupOpenSafe = true;
			for (let q = 0; q < params.length; q++) {
				const norm = params[q]!.length === 0 ? "0" : params[q]!;
				let tk = 1;
				for (let z = 0; z < norm.length; z++) {
					const cc = norm.charCodeAt(z);
					if (cc === CC_SEMI || cc === CC_COLON) tk++;
				}
				if (groupTokens > 0 && (!groupOpenSafe || groupTokens + tk > MERGE_TOKEN_CAP)) {
					out += `\x1b[${group}m`;
					group = "";
					groupTokens = 0;
				}
				group += group.length === 0 ? norm : `;${norm}`;
				groupTokens += tk;
				groupOpenSafe = !endsWithIncompleteExtendedColor(norm);
			}
			if (group.length > 0) out += `\x1b[${group}m`;
			copiedUpto = k;
		}
		i = k;
	}
	if (copiedUpto === 0) return line;
	return out + line.slice(copiedUpto);
}
```

Run: `node --test test/ledger-sgr-coalesce.test.ts` → 应通过。

### Step 5: 写 `src/ledger/terminal-caps-stub.ts`（Phase A 桩）

```ts
// OMP: isMultiplexerSession (388-401) — Bun.env → process.env
export function isMultiplexerSession(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["TMUX"] || env["STY"] || env["ZELLIJ"]) return true;
	if (env["CMUX_WORKSPACE_ID"] || env["CMUX_SURFACE_ID"]) return true;
	const term = (env["TERM"] ?? "").toLowerCase();
	return term.startsWith("tmux") || term.startsWith("screen");
}

// OMP: reportsSizeOnAltScreenToggle (415-420)
function reportsSizeOnAltScreenToggle(env: NodeJS.ProcessEnv = process.env): boolean {
	const override = env["PI_TUI_RESIZE_IN_PLACE"];
	if (override === "0" || override === "false") return false;
	if (override === "1" || override === "true") return true;
	return env["TERM_PROGRAM"]?.toLowerCase() === "warpterminal";
}

// OMP: resizeRepaintsInPlace (428-430)
export function resizeRepaintsInPlace(env: NodeJS.ProcessEnv = process.env): boolean {
	return isMultiplexerSession(env) || reportsSizeOnAltScreenToggle(env);
}

// 同步输出门控（简化版；完整 DECRQM 探测留给 Phase B）
const SYNC_KNOWN = ["xterm-kitty", "xterm-ghostty", "wezterm", "alacritty", "foot", "contour", "kitty", "ghostty"];
export function shouldEnableSyncOutput(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env["PI_FORCE_SYNC_OUTPUT"] === "1") return true;
	if (env["PI_NO_SYNC_OUTPUT"] === "1") return false;
	if (isMultiplexerSession(env)) return false;
	const term = env["TERM"] ?? "";
	return SYNC_KNOWN.some((k) => term.includes(k));
}

// 能力桩：Phase A 不用 kitty ED22 / deccara；isImageLine 由 engine 注入
export const TERMINAL_STUB = {
	supportsScreenToScrollback: false,
	deccara: false,
};
```

### Step 6: 在 `test/virtual-terminal.ts` 末尾追加 `LoggingVirtualTerminal`

```ts
export class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	getWrites(): string {
		return this.writes.join("");
	}
	clearWrites(): void {
		this.writes = [];
	}
}
```

### Step 7: 提交

```bash
git add packages/pi-tui/src/ledger packages/pi-tui/test/virtual-terminal.ts packages/pi-tui/test/ledger-sgr-coalesce.test.ts
git commit -m "feat(pi-tui): scaffold ledger engine types, seam, SGR coalescing"
```

---

## Task 2: 审计核心 `findCommittedPrefixResync`

**Files:**
- Create: `packages/pi-tui/src/ledger/audit.ts`
- Create: `packages/pi-tui/test/ledger-audit.test.ts`

### Step 1: 写失败测试 `test/ledger-audit.test.ts`

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { findCommittedPrefixResync } from "../src/ledger/audit.ts";

describe("findCommittedPrefixResync", () => {
	it("returns -1 when frame matches prefix", () => {
		const prefix = ["a", "b", "c"];
		assert.strictEqual(findCommittedPrefixResync(["a", "b", "c"], prefix), -1);
	});
	it("returns -1 for a single in-place edit within tolerance", () => {
		const prefix = ["a", "b", "c", "d"];
		// one-row edit in the tail sample window → tolerated
		assert.strictEqual(findCommittedPrefixResync(["a", "b", "X", "d"], prefix), -1);
	});
	it("re-anchors at first shifted row on insertion", () => {
		const prefix = ["a", "b", "c", "d"];
		// insertion shifts everything below row 1
		const frame = ["a", "INS", "b", "c", "d"];
		assert.strictEqual(findCommittedPrefixResync(frame, prefix), 1);
	});
	it("re-anchors when frame no longer covers prefix", () => {
		const prefix = ["a", "b", "c", "d"];
		assert.strictEqual(findCommittedPrefixResync(["a", "b"], prefix), 2);
	});
	it("skips the exempt window", () => {
		const prefix = ["a", "b", "c", "d"];
		// row 1-2 differ but are exempt
		const frame = ["a", "X", "Y", "d"];
		assert.strictEqual(findCommittedPrefixResync(frame, prefix, 4, 1, 3), -1);
	});
	it("hard scan catches a finalized forced-row change", () => {
		const prefix = ["a", "b", "c", "d"];
		// permanentEnd=4 forces a full hard scan; row 1 changed → re-anchor at 1
		assert.strictEqual(findCommittedPrefixResync(["a", "Z", "c", "d"], prefix, 4, 4, 4, 4), 1);
	});
	it("treats SGR-only differences as equivalent", () => {
		const prefix = ["\x1b[31mhello\x1b[0m"];
		assert.strictEqual(findCommittedPrefixResync(["\x1b[32mhello\x1b[0m"], prefix), -1);
	});
});
```

Run: `node --test test/ledger-audit.test.ts` → 应失败。

### Step 2: 写 `src/ledger/audit.ts`（OMP: 794-906，逐字移植）

```ts
import { SGR_SEQUENCE } from "./types.ts";

const RESYNC_TAIL_LOOKBACK = 24;
const RESYNC_TAIL_SAMPLES = 8;

// OMP: 795-798
function rowsEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	return a.replace(SGR_SEQUENCE, "") === b.replace(SGR_SEQUENCE, "");
}

// OMP: 800-803
function isBlankRow(row: string): boolean {
	if (row.length === 0) return true;
	return row.replace(SGR_SEQUENCE, "").trim().length === 0;
}

// OMP: 848-906
export function findCommittedPrefixResync(
	frame: readonly string[],
	prefix: readonly string[],
	auditTo: number = prefix.length,
	exemptFrom: number = auditTo,
	exemptTo: number = exemptFrom,
	permanentEnd = 0,
): number {
	const committed = Math.min(prefix.length, Math.max(0, Math.trunc(auditTo)));
	if (committed === 0) return -1;
	const exFrom = Math.max(0, Math.min(committed, Math.trunc(exemptFrom)));
	const exTo = Math.max(exFrom, Math.min(committed, Math.trunc(exemptTo)));
	const audited = (i: number): boolean => i < exFrom || i >= exTo;
	if (frame.length >= committed) {
		const hardEnd = Math.min(committed, Math.max(0, Math.trunc(permanentEnd)));
		let hardMismatch = false;
		for (let i = exTo; i < hardEnd; i++) {
			if (!rowsEquivalent(frame[i]!, prefix[i]!)) {
				hardMismatch = true;
				break;
			}
		}
		if (!hardMismatch) {
			let samples = 0;
			let mismatches = 0;
			let scanned = 0;
			for (let j = 1; j <= committed && scanned < RESYNC_TAIL_LOOKBACK && samples < RESYNC_TAIL_SAMPLES; j++) {
				const idx = committed - j;
				if (!audited(idx)) continue;
				scanned++;
				const row = frame[idx]!;
				const old = prefix[idx]!;
				if (row === old) {
					if (!isBlankRow(row)) samples++;
					continue;
				}
				if (isBlankRow(row) && isBlankRow(old)) continue;
				samples++;
				if (!rowsEquivalent(row, old)) mismatches++;
			}
			if (samples === 0 || mismatches <= 1) return -1;
		}
	}
	const limit = Math.min(committed, frame.length);
	for (let i = 0; i < limit; i++) {
		if (!audited(i)) continue;
		if (!rowsEquivalent(frame[i]!, prefix[i]!)) return i;
	}
	return limit < committed ? limit : -1;
}
```

Run: `node --test test/ledger-audit.test.ts` → 应通过。

### Step 3: 提交

```bash
git add packages/pi-tui/src/ledger/audit.ts packages/pi-tui/test/ledger-audit.test.ts
git commit -m "feat(pi-tui): add committed-prefix resync audit"
```

---

## Task 3: LedgerTuiEngine 骨架 + ledger 字段 + 光标控制

**Files:**
- Create: `packages/pi-tui/src/ledger/engine.ts`（骨架）
- Modify: `packages/pi-tui/src/ledger/types.ts`（如需扩展）

### Step 1: 写 `src/ledger/engine.ts` 骨架（字段 + 构造 + 光标控制）

```ts
import type { Component, Terminal } from "../tui.ts";
import { isImageLine } from "../terminal-image.ts";
import { sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";
import { findCommittedPrefixResync } from "./audit.ts";
import { getNativeScrollbackCommitSafeEnd, getNativeScrollbackLiveRegionStart, getNativeScrollbackSnapshotSafeEnd, getRenderStablePrefixRows, setNativeScrollbackCommittedRows } from "./seam.ts";
import { coalesceAdjacentSgr } from "./sgr-coalesce.ts";
import { isMultiplexerSession, resizeRepaintsInPlace, shouldEnableSyncOutput, TERMINAL_STUB } from "./terminal-caps-stub.ts";
import {
	type CursorControlResult,
	DISABLE_AUTOWRAP,
	ENABLE_AUTOWRAP,
	ERASE_LINE,
	ERASE_TO_END_OF_LINE,
	type FrameSegment,
	HIDE_CURSOR,
	type HardwareCursorState,
	type HardwareCursorUpdate,
	LINE_TERMINATOR,
	type PreparedLine,
	type RenderIntent,
	SEGMENT_RESET,
	SYNC_OUTPUT_BEGIN,
	SYNC_OUTPUT_END,
} from "./types.ts";

export class LedgerTuiEngine {
	// ---- ledger state (OMP: 990-1028) ----
	#committedRows = 0;
	#committedPrefix: string[] = [];
	#committedPrefixAuditRows = 0;
	#committedPrefixDurableRows = 0;
	#windowTopRow = 0;
	#previousWindow: string[] = [];
	#previousFrameLength = 0;
	#previousWidth = 0;
	#previousHeight = 0;
	#hardwareCursorRow = 0;
	#showHardwareCursor = process.env["PI_HARDWARE_CURSOR"] !== "0";

	// ---- seam (per-frame, set by compose) ----
	#nativeScrollbackLiveRegionStart: number | undefined;
	#nativeScrollbackCommitSafeEnd: number | undefined;
	#nativeScrollbackSnapshotSafeEnd: number | undefined;

	// ---- gesture flags (OMP: 1029-1070) ----
	#fullRedrawCount = 0;
	#clearScrollbackOnNextRender = false;
	#forceViewportRepaintOnNextRender = false;
	#hasEverRendered = false;
	#resizeEventPending = false;

	// ---- composed + prepared caches (OMP: 1087-1125) ----
	#composedFrame: string[] = [];
	#frameSegments: FrameSegment[] = [];
	#composeWidth = -1;
	#frameCursorMarkers: { row: number; col: number }[] = [];
	#renderStablePrefixRows = 0;
	#preparedFrame: string[] = [];
	#preparedMeta: PreparedLine[] = [];
	#preparedValidRows = 0;

	// ---- paint framing ----
	readonly #syncEnabled: boolean;
	readonly #paintBeginSequence: string;
	readonly #paintEndSequence: string;

	// children injected by the host TUI (it owns the Container children list)
	constructor(
		private readonly terminal: Terminal,
		private readonly getChildren: () => Component[],
	) {
		this.#syncEnabled = shouldEnableSyncOutput();
		this.#paintBeginSequence = this.#syncEnabled
			? `${HIDE_CURSOR}${SYNC_OUTPUT_BEGIN}${DISABLE_AUTOWRAP}`
			: `${HIDE_CURSOR}${DISABLE_AUTOWRAP}`;
		this.#paintEndSequence = this.#syncEnabled ? `${ENABLE_AUTOWRAP}${SYNC_OUTPUT_END}` : ENABLE_AUTOWRAP;
	}

	get fullRedraws(): number {
		return this.#fullRedrawCount;
	}

	// ---- cursor control (OMP: 3647-3671, 3120-3130) ----
	#targetHardwareCursorState(cursorPos: { row: number; col: number } | null, totalLines: number): HardwareCursorState | null {
		if (!cursorPos || totalLines <= 0) return null;
		return {
			row: Math.max(0, Math.min(cursorPos.row, totalLines - 1)),
			col: Math.max(0, cursorPos.col),
			visible: this.#showHardwareCursor,
		};
	}

	#cursorControlSequence(
		cursorPos: { row: number; col: number } | null,
		totalLines: number,
		fromRow: number,
	): CursorControlResult {
		const target = this.#targetHardwareCursorState(cursorPos, totalLines);
		if (!target) {
			return { seq: "\x1b[?25l", toRow: fromRow, toCol: 0, visible: false, state: null };
		}
		const rowDelta = target.row - fromRow;
		let seq = "";
		if (rowDelta > 0) seq += `\x1b[${rowDelta}B`;
		else if (rowDelta < 0) seq += `\x1b[${-rowDelta}A`;
		seq += `\x1b[${target.col + 1}G`;
		seq += target.visible ? "\x1b[?25h" : "\x1b[?25l";
		return { seq, toRow: target.row, toCol: target.col, visible: target.visible, state: target };
	}

	#recordHardwareCursorUpdate(update: HardwareCursorUpdate): void {
		this.#hardwareCursorRow = update.toRow;
		if (update.state) this.#showHardwareCursor = update.state.visible;
	}
}
```

> 后续任务会往这个类里追加方法（compose / prepare / terminalLine / audit / emit / doRender）。本步先建可编译骨架。

### Step 2: 类型检查

Run（仓库根）: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 通过（`#composeFrame` 等尚未实现，但已声明的方法不报错；如有 unused 警告可接受，后续任务会用到）。

### Step 3: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): add LedgerTuiEngine skeleton with ledger state and cursor control"
```

---

## Task 4: 段式合成 `#composeFrame` + 行摄取

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`

### Step 1: 在 `LedgerTuiEngine` 内追加 `#ingestFrameRow`（OMP: 1296-1312）

```ts
	#ingestFrameRow(line: string): void {
		const CURSOR_MARKER = "\x1b_pi:c\x07";
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) {
			this.#composedFrame.push(line);
			return;
		}
		this.#frameCursorMarkers.push({ row: this.#composedFrame.length, col: visibleWidth(line.slice(0, markerIndex)) });
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		this.#composedFrame.push(stripped);
	}

	#pruneFrameCursorMarkers(fromRow: number): void {
		this.#frameCursorMarkers = this.#frameCursorMarkers.filter((m) => m.row < fromRow);
	}
```

### Step 2: 追加 `#composeFrame`（OMP: 1143-1281）

```ts
	#composeFrame(width: number): readonly string[] {
		width = Math.max(1, width);
		this.#nativeScrollbackLiveRegionStart = undefined;
		this.#nativeScrollbackCommitSafeEnd = undefined;
		this.#nativeScrollbackSnapshotSafeEnd = undefined;
		const children = this.getChildren();
		const previousSegments = this.#frameSegments;
		const segments: FrameSegment[] = new Array(children.length);
		let chainStable = this.#composeWidth === width;
		this.#composeWidth = width;
		let offset = 0;
		let stableRows = 0;

		for (let index = 0; index < children.length; index++) {
			const child = children[index]!;
			const previous = previousSegments[index];
			// Phase A: no component-scoped reuse yet (partial roots = null)
			let childLines: readonly string[];
			let liveLocalStart: number | undefined;
			let commitLocalEnd: number | undefined;
			let snapshotLocalEnd: number | undefined;
			let reported: number | undefined;

			setNativeScrollbackCommittedRows(child, Math.max(0, this.#committedRows - offset));
			childLines = child.render(width);
			const liveRegionStart = getNativeScrollbackLiveRegionStart(child);
			if (liveRegionStart !== undefined) {
				liveLocalStart = Number.isFinite(liveRegionStart)
					? Math.max(0, Math.min(childLines.length, Math.trunc(liveRegionStart)))
					: childLines.length;
				const commitSafeEnd = getNativeScrollbackCommitSafeEnd(child);
				if (commitSafeEnd !== undefined) {
					commitLocalEnd = Number.isFinite(commitSafeEnd)
						? Math.max(liveLocalStart, Math.min(childLines.length, Math.trunc(commitSafeEnd)))
						: childLines.length;
				}
				const snapshotSafeEnd = getNativeScrollbackSnapshotSafeEnd(child);
				if (snapshotSafeEnd !== undefined) {
					const snapshotFloor = commitLocalEnd ?? liveLocalStart;
					snapshotLocalEnd = Number.isFinite(snapshotSafeEnd)
						? Math.max(snapshotFloor, Math.min(childLines.length, Math.trunc(snapshotSafeEnd)))
						: childLines.length;
				}
			}
			reported = getRenderStablePrefixRows(child);

			// topmost seam wins
			if (liveLocalStart !== undefined && this.#nativeScrollbackLiveRegionStart === undefined) {
				this.#nativeScrollbackLiveRegionStart = offset + liveLocalStart;
				if (commitLocalEnd !== undefined) this.#nativeScrollbackCommitSafeEnd = offset + commitLocalEnd;
				if (snapshotLocalEnd !== undefined) this.#nativeScrollbackSnapshotSafeEnd = offset + snapshotLocalEnd;
			}

			if (chainStable) {
				if (previous !== undefined && previous.component === child && previous.start === offset) {
					let stableCount = 0;
					if (reported !== undefined) {
						stableCount = Number.isFinite(reported)
							? Math.max(0, Math.min(childLines.length, previous.rowCount, Math.trunc(reported)))
							: 0;
					} else if (previous.lines === childLines) {
						stableCount = childLines.length;
					}
					stableRows += stableCount;
					if (stableCount < childLines.length || previous.rowCount !== childLines.length) chainStable = false;
				} else {
					chainStable = false;
				}
			}
			segments[index] = { component: child, lines: childLines, start: offset, rowCount: childLines.length, liveLocalStart, commitLocalEnd, snapshotLocalEnd };
			offset += childLines.length;
		}
		this.#frameSegments = segments;

		const frame = this.#composedFrame;
		if (stableRows > frame.length) stableRows = frame.length;
		if (stableRows !== offset || frame.length !== offset) {
			frame.length = stableRows;
			this.#pruneFrameCursorMarkers(stableRows);
			for (const segment of segments) {
				const lines = segment.lines;
				const from = segment.start >= stableRows ? 0 : stableRows - segment.start;
				for (let i = from; i < lines.length; i++) this.#ingestFrameRow(lines[i]!);
			}
		}
		this.#renderStablePrefixRows = stableRows;
		this.#preparedValidRows = Math.min(this.#preparedValidRows, stableRows);
		return frame;
	}
```

### Step 3: 类型检查

Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 通过。

### Step 4: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): implement ledger frame composition with seam capture"
```

---

## Task 5: 帧准备 `#prepareFrame` + per-line 终结

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`

### Step 1: 追加 `#prepareFrame` / `#prepareLinesArray` / `#prepareLine`（OMP: 2900-2943）

```ts
	#prepareFrame(frame: readonly string[], width: number): string[] {
		const prepared = this.#preparedFrame;
		const meta = this.#preparedMeta;
		if (prepared.length > frame.length) {
			prepared.length = frame.length;
			meta.length = frame.length;
		}
		for (let i = Math.min(this.#preparedValidRows, prepared.length); i < frame.length; i++) {
			const raw = frame[i]!;
			const cached = meta[i];
			if (cached !== undefined && cached.raw === raw && cached.width === width) {
				prepared[i] = cached.line;
				continue;
			}
			const entry = this.#prepareLine(raw, width);
			meta[i] = entry;
			prepared[i] = entry.line;
		}
		this.#preparedValidRows = frame.length;
		return prepared;
	}

	#prepareLine(raw: string, width: number): PreparedLine {
		if (isImageLine(raw)) return { raw, width, line: raw };
		const normalized = raw; // Phase A: 假定组件已规范化；如需 normalizeTerminalOutput 在此补
		if (visibleWidth(normalized) <= width) return { raw, width, line: normalized };
		return { raw, width, line: truncateToWidth(normalized, width) };
	}
```

### Step 2: 追加 `#terminalLine` + `#lineRewriteSequence`（OMP: 2450-2454, 3083-3099）

```ts
	#terminalLine(line: string): string {
		if (isImageLine(line)) return line;
		const coalesced = coalesceAdjacentSgr(line);
		return coalesced + (line.includes("\x1b]8;") ? LINE_TERMINATOR : SEGMENT_RESET);
	}

	#lineRewriteSequence(line: string, width: number): string {
		if (isImageLine(line)) return ERASE_LINE + line;
		const terminalLine = this.#terminalLine(line);
		const w = visibleWidth(line);
		if (w >= width) return terminalLine;
		return SEGMENT_RESET + ERASE_TO_END_OF_LINE + terminalLine;
	}
```

### Step 3: 类型检查 + 全量测试（应仍全绿，新代码尚未被 doRender 调用）

Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Run: `node --test test/*.test.ts`
Expected: 全绿。

### Step 4: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): implement ledger frame preparation and per-line finalization"
```

---

## Task 6: 审计方法 `#auditCommittedPrefix` + `#updateCommittedAuditRows`

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`

### Step 1: 追加两个方法（OMP: 2831-2891）

```ts
	// OMP: 2831-2851
	#auditCommittedPrefix(rawFrame: readonly string[], permanentEnd: number): void {
		const prefix = this.#committedPrefix;
		if (prefix.length === 0) return;
		const resyncTo = findCommittedPrefixResync(
			rawFrame,
			prefix,
			prefix.length,
			this.#committedPrefixAuditRows,
			this.#committedPrefixDurableRows,
			permanentEnd,
		);
		if (resyncTo < 0) return;
		this.#committedRows = resyncTo;
		this.#committedPrefixAuditRows = Math.min(this.#committedPrefixAuditRows, resyncTo);
		this.#committedPrefixDurableRows = Math.min(this.#committedPrefixDurableRows, resyncTo);
		prefix.length = resyncTo;
		if (process.env["PI_DEBUG_REDRAW"] === "1") {
			process.stderr.write(`[pi-tui] commit resync at row ${resyncTo}; recommitting\n`);
		}
	}

	// OMP: 2866-2891
	#updateCommittedAuditRows(
		resliced: boolean,
		preCommittedRows: number,
		preAuditRows: number,
		preDurableRows: number,
		byteStableBoundary: number,
		durableBoundary: number,
		hardAudited: boolean,
	): void {
		const committed = this.#committedRows;
		const auditRows =
			resliced || preAuditRows >= preCommittedRows
				? Math.min(committed, byteStableBoundary)
				: Math.min(preAuditRows, committed);
		const durableRows =
			resliced || preDurableRows >= preCommittedRows || hardAudited
				? Math.min(committed, durableBoundary)
				: Math.min(preDurableRows, committed);
		this.#committedPrefixAuditRows = auditRows;
		this.#committedPrefixDurableRows = Math.max(auditRows, durableRows);
	}
```

### Step 2: 追加 `#commit`（OMP: 3105-3118）

```ts
	// OMP: 3105-3118 — 只记录"屏幕上有什么"，不推进 ledger
	#commit(
		lines: readonly string[],
		window: string[],
		width: number,
		height: number,
		hardwareCursor: HardwareCursorUpdate,
	): void {
		this.#previousFrameLength = lines.length;
		this.#previousWindow = window;
		this.#forceViewportRepaintOnNextRender = false;
		this.#previousWidth = width;
		this.#previousHeight = height;
		this.#recordHardwareCursorUpdate(hardwareCursor);
	}
```

### Step 3: 类型检查

Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 通过。

### Step 4: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): add committed-prefix audit and mark updates to ledger engine"
```

---

## Task 7: `#emitFullPaint` + `#emitUpdate`（三形态）

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`

### Step 1: 追加 `#emitFullPaint`（OMP: 3182-3240；deccara/images 桩掉）

```ts
	// OMP: 3182-3240 — 唯一 ED3 call site
	#emitFullPaint(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		options: { clearScrollback: boolean; chunkTo: number; windowTop: number },
	): void {
		this.#fullRedrawCount += 1;
		const { chunkTo, windowTop } = options;
		let buffer = this.#paintBeginSequence;
		if (options.clearScrollback) {
			buffer += "\x1b[2J\x1b[H\x1b[3J";
		} else {
			// Phase A: TERMINAL.supportsScreenToScrollback = false，不发 kitty ED22
			buffer += "\x1b[2J\x1b[H";
		}
		let wroteLine = false;
		for (let i = 0; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#terminalLine(frame[i] ?? "");
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#terminalLine(window[screenRow] ?? "");
			wroteLine = true;
		}
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const parkUp = height - contentRows;
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const contentBottomRow = windowTop + contentRows - 1;
		const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);

		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}
```

### Step 2: 追加 `#emitUpdate`（OMP: 3462-3624；三形态内联）

```ts
	// OMP: 3462-3624
	#emitUpdate(
		frame: readonly string[],
		window: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		options: {
			chunkTo: number;
			windowTop: number;
			prevWindowTop: number;
			prevHardwareCursorRow: number;
			forceWindowRewrite: boolean;
		},
	): void {
		const { chunkTo, windowTop, prevWindowTop, prevHardwareCursorRow, forceWindowRewrite } = options;
		const chunkFrom = this.#committedRows;
		const chunkLength = chunkTo - chunkFrom;
		const scroll = windowTop - prevWindowTop;
		const previousWindow = this.#previousWindow;
		const contentRows = Math.max(1, Math.min(height, frame.length - windowTop));
		const contentBottomRow = windowTop + contentRows - 1;
		const clampedCursor = Math.min(prevHardwareCursorRow, prevWindowTop + height - 1);
		const currentScreenRow = Math.max(0, Math.min(height - 1, clampedCursor - prevWindowTop));

		// ---- shape 1: scroll-append ----
		if (!forceWindowRewrite && chunkLength > 0 && chunkLength === scroll && scroll < height && chunkFrom === prevWindowTop) {
			let prefixIntact = previousWindow.length === height;
			for (let i = 0; prefixIntact && i < chunkLength; i++) {
				if (previousWindow[i] !== frame[chunkFrom + i]) prefixIntact = false;
			}
			if (prefixIntact) {
				let buffer = this.#paintBeginSequence;
				const moveToBottom = height - 1 - currentScreenRow;
				if (moveToBottom > 0) buffer += `\x1b[${moveToBottom}B`;
				for (let r = height - scroll; r < height; r++) {
					buffer += `\r\n${this.#lineRewriteSequence(window[r] ?? "", width)}`;
				}
				let firstChanged = -1;
				let lastChanged = -1;
				for (let r = 0; r < height - scroll; r++) {
					if ((window[r] ?? "") === (previousWindow[r + scroll] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
				let cursorFromRow = windowTop + height - 1;
				if (firstChanged !== -1) {
					const up = height - 1 - firstChanged;
					if (up > 0) buffer += `\x1b[${up}A`;
					buffer += "\r";
					for (let r = firstChanged; r <= lastChanged; r++) {
						if (r > firstChanged) buffer += "\r\n";
						buffer += this.#lineRewriteSequence(window[r] ?? "", width);
					}
					cursorFromRow = windowTop + lastChanged;
				}
				const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, cursorFromRow);
				buffer += cursorControl.seq;
				buffer += this.#paintEndSequence;
				this.terminal.write(buffer);
				this.#committedRows = chunkTo;
				this.#windowTopRow = windowTop;
				this.#commit(frame, window, width, height, cursorControl);
				return;
			}
		}

		// ---- shape 2: in-window diff ----
		if (chunkLength === 0 && scroll === 0) {
			if (forceWindowRewrite) this.#fullRedrawCount += 1;
			let firstChanged = forceWindowRewrite ? 0 : -1;
			let lastChanged = forceWindowRewrite ? height - 1 : -1;
			if (!forceWindowRewrite) {
				const comparable = previousWindow.length === height;
				for (let r = 0; r < height; r++) {
					if (comparable && (window[r] ?? "") === (previousWindow[r] ?? "")) continue;
					if (firstChanged === -1) firstChanged = r;
					lastChanged = r;
				}
			}
			if (firstChanged === -1) {
				this.#writeCursorPosition(cursorPos, frame.length);
				this.#previousWidth = width;
				this.#previousHeight = height;
				return;
			}
			let buffer = this.#paintBeginSequence;
			const rowDelta = firstChanged - currentScreenRow;
			if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
			else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
			buffer += "\r";
			for (let r = firstChanged; r <= lastChanged; r++) {
				if (r > firstChanged) buffer += "\r\n";
				buffer += this.#lineRewriteSequence(window[r] ?? "", width);
			}
			let cursorFromRow = windowTop + lastChanged;
			const contentBottomScreenRow = contentBottomRow - windowTop;
			if (lastChanged > contentBottomScreenRow) {
				buffer += `\x1b[${lastChanged - contentBottomScreenRow}A`;
				cursorFromRow = contentBottomRow;
			}
			const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, cursorFromRow);
			buffer += cursorControl.seq;
			buffer += this.#paintEndSequence;
			this.terminal.write(buffer);
			this.#commit(frame, window, width, height, cursorControl);
			return;
		}

		// ---- shape 3: seam rewrite ----
		this.#fullRedrawCount += 1;
		let buffer = this.#paintBeginSequence;
		if (currentScreenRow > 0) buffer += `\x1b[${currentScreenRow}A`;
		buffer += "\r";
		let wroteLine = false;
		for (let i = chunkFrom; i < chunkTo; i++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(frame[i] ?? "", width);
			wroteLine = true;
		}
		for (let screenRow = 0; screenRow < height; screenRow++) {
			if (wroteLine) buffer += "\r\n";
			buffer += this.#lineRewriteSequence(window[screenRow] ?? "", width);
			wroteLine = true;
		}
		const parkUp = height - 1 - (contentBottomRow - windowTop);
		if (parkUp > 0) buffer += `\x1b[${parkUp}A`;
		const cursorControl = this.#cursorControlSequence(cursorPos, frame.length, contentBottomRow);
		buffer += cursorControl.seq;
		buffer += this.#paintEndSequence;
		this.terminal.write(buffer);
		this.#committedRows = chunkTo;
		this.#windowTopRow = windowTop;
		this.#commit(frame, window, width, height, cursorControl);
	}
```

### Step 3: 追加 `#writeCursorPosition`（in-window diff 的"无变化"早返回用）

```ts
	#writeCursorPosition(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		const cursorControl = this.#cursorControlSequence(cursorPos, totalLines, this.#hardwareCursorRow);
		if (cursorControl.seq.length > 0) this.terminal.write(cursorControl.seq);
		this.#recordHardwareCursorUpdate(cursorControl);
	}
```

### Step 4: 类型检查

Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 通过。

### Step 5: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): implement ledger emitters (fullPaint + update tri-shape)"
```

---

## Task 8: `#doRenderLedger`（分类器 + 窗口数学 + 调度）

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`

### Step 1: 追加公共 `doRender()`（OMP: 2465-2822 主体；去掉 overlay/image/ghostty/resize-drag）

```ts
	// 公共入口（由 TUI.doRender 分发调用）
	public doRender(): void {
		if (this.#stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;

		// 1. compose (Phase A: no partial roots, no image budget pass)
		const rawFrame = this.#composeFrame(width);
		const cursorMarkers = this.#frameCursorMarkers;

		const liveRegionStart = this.#nativeScrollbackLiveRegionStart;
		const commitSafeEnd = this.#nativeScrollbackCommitSafeEnd;
		const snapshotSafeEnd = this.#nativeScrollbackSnapshotSafeEnd;

		// 2. boundaries (OMP: 2599-2604)
		const frameLength = rawFrame.length;
		const byteStableBoundary = Math.max(0, Math.min(frameLength, commitSafeEnd ?? liveRegionStart ?? frameLength));
		const durableBoundary = Math.max(byteStableBoundary, Math.min(frameLength, snapshotSafeEnd ?? byteStableBoundary));

		// 3. transition state (OMP: 2606-2619)
		const prevWindowTop = this.#windowTopRow;
		const prevHardwareCursorRow = this.#hardwareCursorRow;
		const resizeEventOccurred = this.#resizeEventPending;
		this.#resizeEventPending = false;
		const widthChanged = this.#previousWidth > 0 && this.#previousWidth !== width;
		const heightChanged =
			(this.#previousHeight > 0 && this.#previousHeight !== height) ||
			(resizeEventOccurred && this.#previousHeight > 0);
		const geometryChanged = widthChanged || heightChanged;

		// 4. audit (OMP: 2634-2658)
		let committedRowsResynced = false;
		const auditUpper =
			this.#committedPrefixDurableRows < this.#committedRows ? this.#committedRows : this.#committedPrefixAuditRows;
		const hardAuditEnd = Math.min(this.#committedRows, durableBoundary);
		const needHardAudit = this.#committedPrefixDurableRows < hardAuditEnd;
		const auditRan =
			this.#hasEverRendered &&
			!geometryChanged &&
			!this.#clearScrollbackOnNextRender &&
			(this.#renderStablePrefixRows < auditUpper || needHardAudit);
		if (auditRan) {
			const before = this.#committedRows;
			this.#auditCommittedPrefix(rawFrame, durableBoundary);
			committedRowsResynced = this.#committedRows !== before;
		}
		const preCommitRows = this.#committedRows;
		const preCommitAuditRows = this.#committedPrefixAuditRows;
		const preCommitDurableRows = this.#committedPrefixDurableRows;

		// 5. classify + window math (OMP: 2680-2731)
		const firstPaint = !this.#hasEverRendered;
		const replaceRequested = this.#clearScrollbackOnNextRender;
		const geometryRebuild = geometryChanged && !resizeRepaintsInPlace();
		const fullPaint = firstPaint || replaceRequested || geometryRebuild;
		let windowTop: number;
		let chunkTo: number;
		let committedPrefixResliced = false;
		if (fullPaint) {
			committedPrefixResliced = true;
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
		} else if (
			frameLength <= this.#committedRows ||
			(committedRowsResynced &&
				frameLength - this.#committedRows < height &&
				cursorMarkers.some((m) => m.row >= this.#committedRows))
		) {
			windowTop = Math.max(0, frameLength - height);
			chunkTo = windowTop;
			committedPrefixResliced = true;
			this.#committedRows = chunkTo;
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
		} else {
			windowTop = Math.max(this.#committedRows, frameLength - height, 0);
			// hasVisibleOverlay = false (Phase A); geometryChanged freezes commits
			chunkTo = geometryChanged ? this.#committedRows : windowTop;
			if (geometryChanged) {
				committedPrefixResliced = true;
				this.#committedPrefix = rawFrame.slice(0, this.#committedRows);
			}
		}

		// 6. cursor marker + window slice (OMP: 2736-2758)
		let cursorPos: { row: number; col: number } | null = null;
		for (let i = cursorMarkers.length - 1; i >= 0; i--) {
			const marker = cursorMarkers[i]!;
			if (marker.row >= windowTop) {
				cursorPos = marker;
				break;
			}
		}
		const frame = this.#prepareFrame(rawFrame, width);
		const window: string[] = new Array(height);
		for (let r = 0; r < height; r++) window[r] = frame[windowTop + r] ?? "";

		const intent: RenderIntent = fullPaint
			? { kind: "fullPaint", clearScrollback: replaceRequested || geometryRebuild ? !isMultiplexerSession() : false }
			: { kind: "update", chunkTo, windowTop };

		// 7. emit + ledger advance (OMP: 2779-2822)
		if (intent.kind === "fullPaint") {
			this.#emitFullPaint(frame, window, width, height, cursorPos, {
				clearScrollback: intent.clearScrollback,
				chunkTo,
				windowTop,
			});
			this.#committedPrefix = rawFrame.slice(0, chunkTo);
			this.#updateCommittedAuditRows(true, preCommitRows, preCommitAuditRows, preCommitDurableRows, byteStableBoundary, durableBoundary, false);
			this.#clearScrollbackOnNextRender = false;
			this.#hasEverRendered = true;
			return;
		}
		this.#emitUpdate(frame, window, width, height, cursorPos, {
			chunkTo,
			windowTop,
			prevWindowTop,
			prevHardwareCursorRow,
			forceWindowRewrite: this.#forceViewportRepaintOnNextRender || (geometryChanged && resizeRepaintsInPlace()),
		});
		for (let i = this.#committedPrefix.length; i < chunkTo; i++) {
			this.#committedPrefix.push(rawFrame[i] ?? "");
		}
		this.#updateCommittedAuditRows(
			committedPrefixResliced,
			preCommitRows,
			preCommitAuditRows,
			preCommitDurableRows,
			byteStableBoundary,
			durableBoundary,
			auditRan,
		);
	}
```

### Step 2: 追加公共控制方法（供 TUI 调用）

```ts
	#stopped = false;

	public requestFullPaint(clearScrollback: boolean): void {
		if (clearScrollback) this.#clearScrollbackOnNextRender = true;
		else this.#forceViewportRepaintOnNextRender = true;
	}

	public notifyResize(): void {
		this.#resizeEventPending = true;
	}

	public stop(): void {
		this.#stopped = true;
	}

	public reset(): void {
		this.#stopped = false;
		this.#committedRows = 0;
		this.#committedPrefix = [];
		this.#committedPrefixAuditRows = 0;
		this.#committedPrefixDurableRows = 0;
		this.#windowTopRow = 0;
		this.#previousWindow = [];
		this.#previousFrameLength = 0;
		this.#previousWidth = 0;
		this.#previousHeight = 0;
		this.#hasEverRendered = false;
		this.#clearScrollbackOnNextRender = false;
		this.#forceViewportRepaintOnNextRender = false;
		this.#composedFrame = [];
		this.#frameSegments = [];
		this.#composeWidth = -1;
		this.#frameCursorMarkers = [];
		this.#renderStablePrefixRows = 0;
		this.#preparedFrame = [];
		this.#preparedMeta = [];
		this.#preparedValidRows = 0;
	}
```

### Step 3: 类型检查

Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 通过。

### Step 4: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): implement ledger doRender classifier and window math"
```

---

## Task 9: 接入 `TUI`（开关分发）

**Files:**
- Modify: `packages/pi-tui/src/tui.ts`

### Step 1: import + 在 `TUI` 类新增字段

```ts
import { LedgerTuiEngine } from "./ledger/engine.ts";
```

在 `TUI` 类字段区（`fullRedrawCount` 附近）新增：

```ts
	private ledgerEngine: LedgerTuiEngine | undefined;
	private static readonly LEDGER_ENABLED = process.env["PI_TUI_ENGINE"] === "ledger";
```

### Step 2: 重命名旧 `doRender` → `#doRenderLegacy`

把 `private doRender(): void {`（`tui.ts:1254`）改为 `private doRenderLegacy(): void {`。方法体**完全不变**。

### Step 3: 新增分发 `doRender` + 懒初始化 engine

在 `doRenderLegacy` 之后新增：

```ts
	private getLedgerEngine(): LedgerTuiEngine {
		if (!this.ledgerEngine) {
			this.ledgerEngine = new LedgerTuiEngine(this.terminal, () => this.children);
		}
		return this.ledgerEngine;
	}

	private doRender(): void {
		if (TUI.LEDGER_ENABLED) {
			this.getLedgerEngine().doRender();
		} else {
			this.doRenderLegacy();
		}
	}
```

### Step 4: 接线 `requestRender(true)` / `stop` / `fullRedraws` / resize

- 在 `requestRender(force = true)` 的 `force` 分支开头（`:713` 附近）加：
  ```ts
  if (force && TUI.LEDGER_ENABLED) {
  	this.getLedgerEngine().requestFullPaint(true);
  }
  ```
- `fullRedraws` getter（`:336`）改为：
  ```ts
  get fullRedraws(): number {
  	return TUI.LEDGER_ENABLED && this.ledgerEngine ? this.ledgerEngine.fullRedraws : this.fullRedrawCount;
  }
  ```
- 在 `stop()`（约 `:700` 附近，`this.terminal.stop()` 之前）加：
  ```ts
  this.ledgerEngine?.stop();
  ```
- 如 TUI 有终端 resize 回调（`terminal.start(onInput, onResize)` 的 onResize），在回调里加 `this.ledgerEngine?.notifyResize()`；若没有可识别的 resize 回调，跳过（几何变化仍由 `previousWidth/Height` 在下一帧检测）。

### Step 5: 全量测试（默认走 legacy，应全绿）

Run: `node --test test/*.test.ts`
Expected: 全绿（默认 `PI_TUI_ENGINE` 未设置 → legacy 路径，行为不变）。

### Step 6: 提交

```bash
git add packages/pi-tui/src/tui.ts
git commit -m "feat(pi-tui): wire ledger engine behind PI_TUI_ENGINE flag"
```

---

## Task 10: Golden + render-stress 验收

**Files:**
- Create: `packages/pi-tui/test/ledger-engine-golden.test.ts`
- Create: `packages/pi-tui/test/ledger-engine-stress.test.ts`

### Step 1: 写 golden 测试 `test/ledger-engine-golden.test.ts`

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { LoggingVirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

async function withLedger<T>(run: () => Promise<T>): Promise<T> {
	const prev = process.env["PI_TUI_ENGINE"];
	process.env["PI_TUI_ENGINE"] = "ledger";
	try {
		return await run();
	} finally {
		if (prev === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prev;
	}
}

describe("ledger engine golden", () => {
	it("renders basic content", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["Hello", "World"];
			tui.start();
			await terminal.waitForRender();
			const v = terminal.getViewport();
			assert.ok(v[0]?.includes("Hello"));
			assert.ok(v[1]?.includes("World"));
			tui.stop();
		});
	});

	it("commits appended rows and repaints window on streaming append", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["L0", "L1", "L2"];
			tui.start();
			await terminal.waitForRender();
			// append beyond viewport
			for (let i = 3; i < 12; i++) {
				c.lines = [...c.lines, `L${i}`];
				tui.requestRender();
				await terminal.waitForRender();
			}
			const v = terminal.getViewport();
			assert.ok(v.join("\n").includes("L11"), `tail visible: ${v.join("|")}`);
			tui.stop();
		});
	});

	it("clamps over-wide lines instead of throwing", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(10, 4);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["1234567890ABCDEF"];
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.includes("1234567890"));
			c.lines = ["ok"];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(terminal.getViewport()[0]?.includes("ok"));
			tui.stop();
		});
	});

	it("handles content shrink", async () => {
		await withLedger(async () => {
			const terminal = new LoggingVirtualTerminal(40, 8);
			const tui = new TUI(terminal);
			const c = new TestComponent();
			tui.addChild(c);
			c.lines = ["a", "b", "c", "d"];
			tui.start();
			await terminal.waitForRender();
			c.lines = ["a", "b"];
			tui.requestRender();
			await terminal.waitForRender();
			const v = terminal.getViewport();
			assert.ok(v[0]?.includes("a"));
			assert.ok(v[1]?.includes("b"));
			tui.stop();
		});
	});
});
```

Run: `node --test test/ledger-engine-golden.test.ts` → 调试至通过（这是新引擎的首次端到端验证，预计需要迭代修复 wiring）。

### Step 2: 写 render-stress 测试 `test/ledger-engine-stress.test.ts`

> 种子化随机操作序列，把新引擎 emit 的字节喂给 `VirtualTerminal`，断言：(a) 视口与"朴素全量重绘参考"一致；(b) scrollback 只增不减（追加式）。

```ts
import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_w: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function withLedger<T>(run: () => Promise<T>): Promise<T> {
	const prev = process.env["PI_TUI_ENGINE"];
	process.env["PI_TUI_ENGINE"] = "ledger";
	try {
		return await run();
	} finally {
		if (prev === undefined) delete process.env["PI_TUI_ENGINE"];
		else process.env["PI_TUI_ENGINE"] = prev;
	}
}

describe("ledger engine stress (seeded)", () => {
	for (const seed of [1, 2, 3, 7, 42, 99]) {
		it(`seed=${seed}: viewport consistent, scrollback append-only`, async () => {
			await withLedger(async () => {
				const rand = mulberry32(seed);
				const terminal = new VirtualTerminal(40, 8);
				const tui = new TUI(terminal);
				const c = new TestComponent();
				tui.addChild(c);
				c.lines = ["init"];
				tui.start();
				await terminal.waitForRender();

				let prevScrollbackLen = terminal.getScrollBuffer().length;
				for (let step = 0; step < 60; step++) {
					const op = rand();
					const len = c.lines.length;
					if (op < 0.5) {
						// append
						c.lines = [...c.lines, `s${step}-a`];
					} else if (op < 0.75 && len > 1) {
						// mutate a live tail row
						const copy = c.lines.slice();
						copy[copy.length - 1] = `s${step}-m`;
						c.lines = copy;
					} else if (op < 0.9 && len > 1) {
						// shrink
						c.lines = c.lines.slice(0, Math.max(1, len - 1 - Math.floor(rand() * 3)));
					} else {
						// resize
						terminal.resize(30 + Math.floor(rand() * 40), 6 + Math.floor(rand() * 6));
					}
					tui.requestRender();
					await terminal.waitForRender();

					// invariant: scrollback length never decreases
					const sb = terminal.getScrollBuffer();
					assert.ok(sb.length >= prevScrollbackLen, `seed=${seed} step=${step}: scrollback shrank`);
					prevScrollbackLen = sb.length;

					// invariant: viewport tail reflects the latest content
					const viewport = terminal.getViewport();
					const lastLine = c.lines[c.lines.length - 1]!;
					assert.ok(
						viewport.join("\n").includes(lastLine.slice(0, Math.min(10, lastLine.length))),
						`seed=${seed} step=${step}: tail not visible`,
					);
				}
				tui.stop();
			});
		});
	}
});
```

Run: `node --test test/ledger-engine-stress.test.ts` → 这是**Phase A 的总验收**。预计需要多轮迭代修复（分类器/窗口数学/审计的边界）。**只有在 6 个 seed 全绿后**才进入 Task 11。

### Step 3: 跑全量测试

Run: `node --test test/*.test.ts`
Expected: 全绿（legacy 默认 + ledger 显式开的测试都过）。

### Step 4: 提交

```bash
git add packages/pi-tui/test/ledger-engine-golden.test.ts packages/pi-tui/test/ledger-engine-stress.test.ts
git commit -m "test(pi-tui): add golden and seeded stress harness for ledger engine"
```

---

## Task 11: 切默认 + 删除旧引擎

**Files:**
- Modify: `packages/pi-tui/src/tui.ts`
- Modify: `packages/pi-tui/src/tui.ts`（`fullRedraws` getter 还原）

> **前置条件**：Task 10 的 golden + 6 个 stress seed 全绿，且全量测试无回归。**不要做**这一步，除非 Task 10 通过。

### Step 1: 把默认改为 ledger

把 `private static readonly LEDGER_ENABLED = process.env["PI_TUI_ENGINE"] === "ledger";` 改为：

```ts
	private static readonly LEGACY_ENABLED = process.env["PI_TUI_ENGINE"] === "legacy";
```

并把 `doRender()` 分发改为：

```ts
	private doRender(): void {
		if (TUI.LEGACY_ENABLED) {
			this.doRenderLegacy();
		} else {
			this.getLedgerEngine().doRender();
		}
	}
```

`requestRender(true)` 分支里的 `TUI.LEDGER_ENABLED` 判断同步改为 `!TUI.LEGACY_ENABLED`。`fullRedraws` getter 同步改为默认走 engine。

### Step 2: 全量测试 + 类型检查

Run: `node --test test/*.test.ts`
Run: `pnpm --filter @moonshot-ai/pi-tui typecheck`
Expected: 全绿（现在默认 ledger；legacy 仅在 `PI_TUI_ENGINE=legacy` 时启用）。

### Step 3:（可选）删除旧引擎

> 若团队希望保留 `PI_TUI_ENGINE=legacy` 回退一个版本，**跳过本步**，留待后续 PR 清理。

删除 `doRenderLegacy()` 方法体及所有 legacy-only 字段（`previousLines`、`maxLinesRendered`、`previousViewportTop`、`clearOnShrink` 等），并删除 `doRender()` 的分发（直接 `this.getLedgerEngine().doRender()`）。删除后跑全量测试。

### Step 4: 提交

```bash
git add packages/pi-tui/src/tui.ts
git commit -m "refactor(pi-tui): make ledger engine the default renderer"
```

---

## 验收总清单

- [ ] `node --test test/*.test.ts` 全绿（Task 10 后默认仍 legacy；Task 11 后默认 ledger）
- [ ] `pnpm --filter @moonshot-ai/pi-tui typecheck` 通过
- [ ] golden 4 场景通过
- [ ] stress 6 seed 通过（scrollback 只增不减 + tail 可见）
- [ ] 现有 27 个测试无回归
- [ ] 手动：`PI_TUI_ENGINE=ledger` 启动 CLI，流式输出 / resize / 超宽行 / spinner 正常

---

## Self-Review

**1. Spec 覆盖（设计目标 → 任务）：**

| 目标 | 任务 |
|---|---|
| 追加式 native scrollback 账本 | Task 3（字段）+ Task 6（审计）+ Task 8（窗口数学） |
| `NativeScrollbackLiveRegion` seam | Task 1（接口）+ Task 4（compose 捕获） |
| 范围感知 committed-prefix 审计 | Task 2 + Task 6 |
| render intent 分类器 | Task 8 |
| `#emitFullPaint`（唯一 ED3） | Task 7 |
| `#emitUpdate` 三形态 | Task 7 |
| SGR 合并 | Task 1 |
| 超宽行 clamp | Task 5（`#prepareLine`） |
| 同步输出门控 | Task 1（简化版） |
| 多路复用检测 | Task 1 |
| render-stress 验收 | Task 10 |

**明确不在 Phase A（留后续 Phase）：** overlay 合成（硬编码 false）、resize viewport drag fast path（Phase B）、完整 DA1/DECRQM（Phase B）、DECCARA（Phase B/C）、ImageBudget 实装（Phase C）、app 层 seam 接入（Phase C）、废弃 sliding window（Phase C）、完整 fuzz + reducer（Phase D）。

**2. 占位符扫描：** 无 TBD/TODO。Task 9/10 标注了"预计需要迭代"（这是新引擎首次端到端，属正常的工程预期，非占位）。

**3. 类型/接口一致性：**
- `LedgerTuiEngine` 公共 API：`doRender()` / `requestFullPaint(clearScrollback)` / `notifyResize()` / `stop()` / `reset()` / `fullRedraws` — Task 8 定义，Task 9 使用，一致。
- `Terminal` 类型来自 `../tui.ts`（已有 `write`/`columns`/`rows`）；engine 用 `this.terminal.write`，一致。
- `Component.render(width): string[]` — 我们的 `Component` 接口匹配（`#composeFrame` 调 `child.render(width)`）。
- `isImageLine` 来自 `../terminal-image.ts`（已存在）。
- `visibleWidth` / `truncateToWidth` / `sliceByColumn` 来自 `../utils.ts`（已存在）。
- `RenderIntent` / `FrameSegment` / `PreparedLine` / cursor 类型在 `types.ts` 定义，engine import，一致。

**4. 风险标注：**
- Task 9（wiring）：engine/TUI 边界（force/stop/resize/fullRedraws）可能需迭代；已给出具体接点。
- Task 10（stress）：新引擎首次端到端，预计多轮修复；stress 是总验收，绿了才切默认（Task 11 前置条件）。
- overlay 硬编码 false：我们的 app 不用 showOverlay（已确认），安全。
- `normalizeTerminalOutput` 在 `#prepareLine` 里简化为 `raw`；若 stress 暴露控制字符问题，补一个最小 normalize。

**5. 忠实度：** 核心算法（审计、窗口数学、emit 三形态）逐字移植 OMP（标注了行号）；仅在依赖替换（Bun→process.env、桩掉 deccara/images/overlay）和 `render`→`#composeFrame` 改名上偏离，属必要适配。
