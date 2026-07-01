# Phase D 实施计划：render-stress 模糊测试加固

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase A 的 6 个 seed 的简化 stress 升级成 oh-my-pi 级别的渲染正确性验证网：独立的 **shadow commit ledger oracle**（断言 `scrollback == frame[0..C)`）、覆盖更多操作类型的**全 fuzz  harness**、失败 seed 的 **delta-debug reducer**、更忠实的 **ghostty-web VT oracle**（可选），以及 CI 集成与 benchmark。这是账本引擎的**最终安全网**，也是后续任何渲染器改动的回归底线。

**Architecture:** 改动集中在 `packages/pi-tui/test/render-stress-*` + `bench/`。shadow ledger 是引擎合约的**独立复刻**（不 import 引擎实现），用它校验引擎 emit 的真实字节喂给 VT 后的 scrollback 状态。reducer 对失败 seed 做 delta-debug 收缩到最小复现。

**Tech Stack:** TypeScript（Node 24）、`node --test`、`@xterm/headless`（默认 oracle）、`ghostty-web`（可选，更忠实）、`tinybench` 或自写 `performance.now`（bench）。

**依赖：** Phase A/B/C 完成（账本引擎 + 终端层 + app 接入稳定）。

---

## 关键设计决策

1. **Shadow ledger 是独立复刻，不 import 引擎**：它重新实现 `findCommittedPrefixResync` 的 commit 法则和窗口数学的**简化版**，独立预测"给定操作序列后 scrollback 应该是什么"。如果 shadow 与引擎一致，引擎正确；如果不一致，要么引擎错、要么 shadow 错（都需要查）。这种"双实现"是模糊测试的核心。
2. **VT oracle 分层**：默认用 `@xterm/headless`（已在 devDep，快）；高忠实度场景（grapheme/ZWJ/BCE）用 `ghostty-web`（可选，慢但准）。两套 oracle 跑同一批 seed，交叉验证。
3. **Reducer 只对失败 seed 工作**：fuzz 发现失败 seed 后，reducer 通过"删操作/缩短序列/简化内容"的 delta-debug 把复现收缩到最小，写入 `test/render-stress-failures/` 供调试。
4. **Stress 默认 local-only**：`SKIP_IN_CI` 标记（fuzz 慢且非确定性）；CI 只跑 golden + 固定 seed。nightly 可跑全量 fuzz。

---

## 约定

- **工作目录**：`packages/pi-tui/`。
- **跑 stress**：`node --test test/render-stress.test.ts`（local）；`PI_TUI_STRESS_SEEDS=1000 node --test ...`（加大 seed 数）。
- **跑 bench**：`node bench/<name>.ts`。
- **提交规范**：`test(pi-tui):` / `chore(pi-tui):`；无 co-author；无 claude。

---

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `test/render-stress-oracles.ts` | 新建 | shadow commit ledger + VT oracle（xterm/ghostty） |
| `test/render-stress-harness.ts` | 新建 | 种子化随机 op 生成器 + 执行器 |
| `test/render-stress-reducer.ts` | 新建 | delta-debug 失败收缩 |
| `test/render-stress.test.ts` | 修改 | 接入 oracle + reducer（替换 Phase A 的简化版） |
| `bench/emit.ts` | 新建 | emit 字节体积/延迟基准 |
| `bench/compose.ts` | 新建 | frame compose 基准 |
| `bench/parse-key.ts` | 新建 | key 解析基准 |
| `test/render-stress-failures/` | 新建（运行时生成） | reducer 输出的最小复现 |

---

## Task 1: Shadow commit ledger oracle

**Files:**
- Create: `packages/pi-tui/test/render-stress-oracles.ts`

### Step 1: 实现 shadow ledger

> 独立复刻引擎的 commit 法则。给定操作序列（append/mutate/shrink/resize）和每帧的"组件 lines + seam"，shadow 预测每帧结束后 scrollback 应有哪些行。

```ts
export interface ShadowOp {
	kind: "append" | "mutate-tail" | "shrink" | "resize" | "finalize-tail";
	lines?: string[];
	width?: number;
	height?: number;
}

export class ShadowLedger {
	private scrollback: string[] = [];
	private windowTop = 0;

	/** 喂入一帧的"组件 lines + seam 边界 + 视口高"，shadow 预测 emit 后的 scrollback。 */
	applyFrame(frame: string[], liveRegionStart: number | undefined, height: number): void {
		const frameLength = frame.length;
		const byteStableBoundary = liveRegionStart ?? frameLength;
		// commit 地板 = windowTop（追加式）
		const newWindowTop = Math.max(this.scrollback.length, frameLength - height, 0);
		// 新 commit 的行 = [scrollback.length, newWindowTop)，且必须 ≤ byteStableBoundary
		const commitTo = Math.min(newWindowTop, byteStableBoundary);
		for (let i = this.scrollback.length; i < commitTo; i++) {
			this.scrollback.push(frame[i]!);
		}
		this.windowTop = newWindowTop;
	}

	getScrollback(): string[] {
		return this.scrollback;
	}
}
```

> 注：shadow 是引擎法则的**简化**复刻（不含审计 resync/durable-exempt 的 subtle 细节，因为 shadow 假设组件 seam 诚实）。它校验"在 seam 诚实的前提下，引擎是否按 append-only 法则 commit"。审计 resync 由单独的 oracle（Task 2）覆盖。

### Step 2: VT oracle

```ts
import { VirtualTerminal } from "./virtual-terminal.ts";

export async function runEngineAndCapture(
	ops: ShadowOp[],
	width: number,
	height: number,
): Promise<{ scrollback: string[]; viewport: string[] }> {
	// 用 ops 驱动一个 TestComponent + TUI（ledger），每帧 requestRender + waitForRender，
	// 最后返回 VT 的 getScrollBuffer() + getViewport()。
	throw new Error("implement in Phase D");
}
```

### Step 3: 一致性断言

```ts
function assertMatchesOracle(
	actual: { scrollback: string[]; viewport: string[] },
	shadow: ShadowLedger,
	frame: string[],
): void {
	const expected = shadow.getScrollback();
	// 引擎的 scrollback 应等于 shadow 预测的 scrollback（逐行，剥离 SGR 后比较）
	assert.deepStrictEqual(
		actual.scrollback.map(stripSgr),
		expected.map(stripSgr),
		"scrollback must match shadow ledger",
	);
}
```

### Step 4: 提交

```bash
git add packages/pi-tui/test/render-stress-oracles.ts
git commit -m "test(pi-tui): add shadow commit ledger oracle for render stress"
```

---

## Task 2: 全 fuzz harness（扩展 op 类型）

**Files:**
- Create: `packages/pi-tui/test/render-stress-harness.ts`
- Modify: `packages/pi-tui/test/render-stress.test.ts`

### Step 1: op 生成器（扩展 Phase A 的 6 seed）

```ts
export type StressOp =
	| { kind: "append"; text: string }
	| { kind: "mutate"; index: number; text: string }
	| { kind: "shrink"; toLength: number }
	| { kind: "resize"; width: number; height: number }
	| { kind: "finalize" } // transient → finalized
	| { kind: "overlay-open" } // Phase C 后启用
	| { kind: "overlay-close" }
	| { kind: "image-place" }; // Phase C 后启用

export function* generateOps(seed: number, count: number): Generator<StressOp> {
	const rand = mulberry32(seed);
	for (let i = 0; i < count; i++) {
		const r = rand();
		if (r < 0.4) yield { kind: "append", text: `line-${i}-${rand().toString(36).slice(2, 6)}` };
		else if (r < 0.6) yield { kind: "mutate", index: -1, text: `mut-${i}` }; // -1 = tail
		else if (r < 0.72) yield { kind: "shrink", toLength: Math.max(1, Math.floor(rand() * 8)) };
		else if (r < 0.85) yield { kind: "resize", width: 20 + Math.floor(rand() * 80), height: 4 + Math.floor(rand() * 16) };
		else yield { kind: "finalize" };
	}
}
```

### Step 2: 替换 Phase A 的简化 stress

把 Phase A 的 `test/ledger-engine-stress.test.ts`（6 seed）替换为调用 `generateOps` + `assertMatchesOracle` 的版本，seed 数默认 50（local），`PI_TUI_STRESS_SEEDS` 覆盖。

### Step 3: 审计 resync oracle（独立校验）

增加一类 op：`{ kind: "mutate-committed" }`（故意改一个已 commit 的 byte-stable 行，模拟组件重排），断言引擎通过审计 resync 重新锚定（scrollback 出现重复但不丢行）。这覆盖 shadow 不覆盖的审计路径。

### Step 4: 跑 fuzz

Run: `PI_TUI_STRESS_SEEDS=200 node --test test/render-stress.test.ts`
Expected: 全绿（若失败，进入 Task 3 reducer）。

### Step 5: 提交

```bash
git add packages/pi-tui/test/render-stress-harness.ts packages/pi-tui/test/render-stress.test.ts
git commit -m "test(pi-tui): expand render stress fuzz with oracle and more op types"
```

---

## Task 3: Delta-debug reducer

**Files:**
- Create: `packages/pi-tui/test/render-stress-reducer.ts`

### Step 1: 实现 reducer

```ts
/** 对一个失败 seed 的 op 序列做 delta-debug 收缩，返回仍失败的最小子序列。 */
export function reduceFailure(
	seed: number,
	runOps: (ops: StressOp[]) => Promise<{ ok: boolean; error?: string }>,
): Promise<StressOp[]> {
	let ops = [...generateOps(seed, MAX_OPS)];
	let changed = true;
	while (changed) {
		changed = false;
		// 1. 尝试删除每个 op
		for (let i = ops.length - 1; i >= 0; i--) {
			const candidate = ops.slice(0, i).concat(ops.slice(i + 1));
			if (candidate.length === 0) continue;
			const result = await runOps(candidate);
			if (!result.ok) {
				ops = candidate;
				changed = true;
			}
		}
		// 2. 尝试缩短每个 append 的 text
		// 3. 尝试把 resize 的幅度减半
	}
	return ops;
}
```

### Step 2: 失败时自动写最小复现

在 stress 测试的失败回调里：

```ts
if (!result.ok) {
	const minimal = await reduceFailure(seed, runOps);
	const path = `test/render-stress-failures/seed-${seed}.json`;
	fs.writeFileSync(path, JSON.stringify(minimal, null, 2));
	assert.fail(`stress failed seed=${seed}; minimal repro written to ${path}`);
}
```

### Step 3: 最小复现可重放

加一个测试：读取 `test/render-stress-failures/*.json`，重放每个最小复现，断言通过（修复后）或失败（未修复时，作为已知失败记录）。

### Step 4: 提交

```bash
git add packages/pi-tui/test/render-stress-reducer.ts
git commit -m "test(pi-tui): add delta-debug reducer for render stress failures"
```

---

## Task 4: Ghostty-web VT oracle（可选，高忠实度）

**Files:**
- Create: `packages/pi-tui/test/ghostty-oracle.ts`
- Modify: `packages/pi-tui/test/render-stress-oracles.ts`

### Step 1: 接入 ghostty-web

> ghostty-web 是 Ghostty 真实 VT100 解析器编到 WASM，grapheme/ZWJ/BCE 正确，比 `@xterm/headless` 更忠实。OMP 用它做 ground truth。

```ts
// 可选依赖：pnpm add -D ghostty-web（如可获取）
// 实现 GhosttyTerminal implements Terminal，同 VirtualTerminal 的接口
```

### Step 2: 双 oracle 交叉验证

stress 的每个 seed 同时在 xterm + ghostty 两个 VT 上跑，断言两者 scrollback/viewport 一致（剥离实现差异后）。差异即潜在的 xterm 近似误差或引擎 bug。

### Step 3: 提交

```bash
git add packages/pi-tui/test/ghostty-oracle.ts packages/pi-tui/test/render-stress-oracles.ts
git commit -m "test(pi-tui): add ghostty-web VT oracle for high-fidelity stress"
```

---

## Task 5: CI 集成 + Benchmark

**Files:**
- Modify: `packages/pi-tui/package.json`（scripts）
- Create: `packages/pi-tui/bench/emit.ts`、`compose.ts`、`parse-key.ts`

### Step 1: CI 脚本

```json
{
	"scripts": {
		"test": "node --test test/*.test.ts",
		"test:stress": "node --test test/render-stress.test.ts",
		"test:stress:full": "PI_TUI_STRESS_SEEDS=2000 node --test test/render-stress.test.ts"
	}
}
```

CI 跑 `test`（含 golden + 默认 50 seed stress）；nightly 跑 `test:stress:full`。

### Step 2: Benchmark

`bench/emit.ts`：构造一个 1000 行 frame，分别跑 legacy 与 ledger 的 doRender，对比 emit 字节数 + 延迟。

```ts
import { performance } from "node:perf_hooks";
// ... 构造场景，跑 N 次，输出 p50/p99 延迟 + 字节数
```

### Step 3: 提交

```bash
git add packages/pi-tui/package.json packages/pi-tui/bench
git commit -m "chore(pi-tui): add stress CI scripts and render benchmarks"
```

---

## 验收总清单

- [ ] shadow ledger 与引擎在 200+ seed 下 scrollback 一致。
- [ ] fuzz 覆盖 append/mutate/shrink/resize/finalize/mutate-committed。
- [ ] reducer 能把失败 seed 收缩到 ≤5 op 的最小复现。
- [ ] （可选）ghostty-web 与 xterm oracle 交叉验证一致。
- [ ] CI 跑默认 stress，nightly 跑全量。
- [ ] benchmark 显示 ledger 相对 legacy 的帧字节/延迟改善。

---

## Self-Review

**1. 覆盖：** shadow oracle（Task 1）、fuzz（Task 2）、reducer（Task 3）、ghostty（Task 4，可选）、CI+bench（Task 5）。覆盖 Agent A/E 报告的 render-stress 全套（oracles/reducer/scheduler/ghostty）。

**2. 占位：** Task 1 的 `runEngineAndCapture` 是 `throw "implement in Phase D"` scaffold——Phase D 启动时填充。这是设计级计划的正常占位，非 TBD。

**3. 一致性：** `ShadowLedger.applyFrame` 的 commit 法则与 Phase A 引擎的窗口数学一致（`windowTop = max(committedRows, frameLength - height, 0)`，commit 地板 = windowTop）。`StressOp` 类型在 Task 2/3 一致。

**4. 风险：**
- shadow ledger 是简化复刻，不覆盖审计 resync/durable-exempt 的 subtle 细节（Task 2 Step 3 用专门的 `mutate-committed` op 补覆盖）。
- ghostty-web 引入 WASM 依赖（Task 4 标可选，不阻塞主线）。
- fuzz 非确定性：用固定 seed + reducer 把失败固化成可重放的最小复现（Task 3）。
