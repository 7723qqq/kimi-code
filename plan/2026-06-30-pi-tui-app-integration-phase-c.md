# Phase C 实施计划：App 层接入（废弃 sliding window，接通 seam）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `apps/kimi-code` 的 transcript 接入 Phase A 的账本引擎： transcript 容器上报 `NativeScrollbackLiveRegion` seam（区分 byte-stable 历史行与 live 流式尾），废弃"主动销毁旧渲染行"的 rendered sliding window（让行 commit 进 native scrollback），重想 `mergeCurrentTurnSteps`/`StepSummary` 在 append-only 下的语义，并把 loader 切到组件级渲染。

**Architecture:** 改动集中在 `apps/kimi-code/src/tui/`（transcript 容器、streaming、transcript-window、loader）+ pi-tui 引擎补 `requestComponentRender`（partial roots）。**核心认知**：账本引擎的审计会自动处理 app 的组件 swap（"duplication, never loss" 重新锚定），所以 Phase C 的主线不是"让 app 不变"，而是"正确上报 seam + 放松 rendered window"。

**Tech Stack:** TypeScript（Node 24）、`node --test`、app 现有测试基座。

**依赖：** Phase A（账本引擎默认）+ Phase B（终端能力/resize defer）已完成。

**前置 deep-dive：** 启动 Phase C 时，先派 plan agent 逐字提取 `apps/kimi-code/src/tui/kimi-tui.ts` 的 `appendTranscriptEntry` / `trimTranscriptWindow` / `mergeCurrentTurnSteps`、`controllers/streaming-ui.ts` 的 streaming 路径、`components/chrome/gutter-container.ts`，把任务里的设计落为逐行改动。

---

## 关键设计决策（核心：app 内存模型）

### 决策 1：seam 由 `transient` 标志驱动

`AssistantMessageComponent.updateContent(fullText, { transient })` 的 `transient` 就是天然的 byte-stable/live 边界：
- `transient: false`（已 finalize）的消息 → byte-stable（永不重排），可 commit。
- `transient: true`（流式中）的消息 → live（每帧变），不可 commit。

transcript 容器（`GutterContainer` 或包一层 `TranscriptContainer`）实现 `NativeScrollbackLiveRegion`：

```ts
getNativeScrollbackLiveRegionStart(): number | undefined {
	// 返回"第一个 still-live 行"的局部行索引；其前全是 byte-stable
	// 实现：遍历子组件，找到第一个 transient 的 assistant 消息的起始行
}
getNativeScrollbackCommitSafeEnd(): number | undefined {
	// 流式 assistant 消息内部可能有"已稳定的前缀"（append-only 的 token）
	// 初期可不实现（默认 = liveRegionStart），Phase D 优化时再加
	return undefined;
}
```

### 决策 2：废弃 rendered sliding window，保留 logical window

**当前**：`transcript-window.ts` 把 rendered children 限制在最近 50 轮，`trimTranscriptWindow()` 销毁旧行、`mergeCurrentTurnSteps()` 把旧步骤合并成 `StepSummaryComponent`（**会替换/销毁已渲染组件**）。

**问题**：append-only 账本下，已 commit 的行在 native scrollback 里不可变；销毁组件会触发"frame shrank into committed prefix"分支，导致重新展示 frame tail + 重新切片 prefix + 接受重复（功能正确但有 scrollback 重复，且抵消了账本的主要收益）。

**新模型**：
- **Rendered transcript 不再销毁旧行**：让旧行 commit 进 native scrollback，组件在行滚出窗口后可被引擎释放（引擎只渲染 window）。`trimTranscriptWindow` 改为只裁剪 **logical** `transcriptEntries`（用于 LLM context），不销毁 rendered children。
- **Logical window 保留**：`transcriptEntries` 仍限制最近 N 轮（控制 LLM context 大小），但这是逻辑层，不影响渲染。

> **影响**：长会话的 rendered 行数会增长，但引擎只渲染 window（height 行），已 commit 的行只在 scrollback 里（终端持有），内存不随会话长度线性增长（账本只持 `committedPrefix` 引用 + window）。这与 OMP 的模型一致。

### 决策 3：`mergeCurrentTurnSteps` / `StepSummary` 改为 append-only

**当前**：把已渲染的多个 step 组件**替换**成一个 `StepSummaryComponent`（`children[idx] = group`）。

**新模型（推荐）**：StepSummary 作为**追加的新行**（live region 内），不替换已 commit 的 step。旧 step 留在 scrollback 里，summary 作为新内容追加在下方。这是"duplication, never loss"——step 在 scrollback 里，summary 在 window 里，可接受。

**备选**：保留替换，依赖审计重新锚定（duplication never loss）。功能正确但 scrollback 会有重复。仅在决策 3 推荐方案落地困难时采用。

> **需 app 团队确认**：决策 2/3 改了 transcript 的内存与显示语义，是 Phase C 唯一需要产品/架构拍板的地方。计划默认采用"放松 rendered window + StepSummary append-only"。

### 决策 4：组件级渲染（partial roots）补到引擎

Phase A 的 `#composeFrame` 留了 `partialRoots = null` 的桩。Phase C 实现 `#resolvePartialComposeRoots` + segment reuse，并新增 `TUI.requestComponentRender(component)`。loader 的高频帧切到 `requestComponentRender(this)`，避免整树重渲。

---

## 约定

- **工作目录**：仓库根（app 改动跨 `apps/kimi-code` 和 `packages/pi-tui`）。
- **跑 app 测试**：`pnpm --filter @moonshot-ai/kimi-code test`（或对应脚本）。
- **跑 pi-tui 测试**：`cd packages/pi-tui && node --test test/*.test.ts`。
- **提交规范**：`feat(kimi-code):` / `refactor(kimi-code):` / `feat(pi-tui):`；无 co-author；无 claude。

---

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `apps/kimi-code/src/tui/components/chrome/transcript-container.ts` | 新建/修改 | `TranscriptContainer`（或扩 `GutterContainer`）实现 `NativeScrollbackLiveRegion` |
| `apps/kimi-code/src/tui/utils/transcript-window.ts` | 修改 | 改为只裁剪 logical entries，不销毁 rendered children |
| `apps/kimi-code/src/tui/kimi-tui.ts` | 修改 | `appendTranscriptEntry` / `mergeCurrentTurnSteps` 接新模型；loader `requestComponentRender` |
| `apps/kimi-code/src/tui/controllers/streaming-ui.ts` | 修改 | streaming seam 上报；StepSummary append-only |
| `packages/pi-tui/src/ledger/engine.ts` | 修改 | 补 `#resolvePartialComposeRoots` + `requestComponentRender` |
| `packages/pi-tui/src/tui.ts` | 修改 | 暴露 `requestComponentRender` |
| `packages/pi-tui/src/components/image.ts` | 修改 | 实装 `ImageBudget`（替换 Phase A 桩） |
| `apps/kimi-code/src/tui/.../transcript-container.test.ts` | 新建 | seam 行为 |
| `apps/kimi-code/src/tui/.../transcript-window.test.ts` | 新建/修改 | logical window 行为 |

---

## Task 1: TranscriptContainer seam（`NativeScrollbackLiveRegion`）

**Files:**
- Create/Modify: `apps/kimi-code/src/tui/components/chrome/transcript-container.ts`
- Create: 对应测试

### Step 1: 实现 seam

让 transcript 容器（`GutterContainer` 子类或新 `TranscriptContainer`）实现：

```ts
import type { NativeScrollbackLiveRegion } from "@moonshot-ai/pi-tui/ledger/seam";

class TranscriptContainer extends GutterContainer implements NativeScrollbackLiveRegion {
	// 返回第一个 still-live（transient）行的局部行索引；其前全 byte-stable
	getNativeScrollbackLiveRegionStart(): number | undefined {
		let row = 0;
		for (const child of this.children) {
			const lines = child.render(this.width);
			if (isLive(child)) {
				return row; // 第一个 live 子组件的起始行
			}
			row += lines.length;
		}
		return undefined; // 全部 byte-stable（shell 语义：滚出的全 commit）
	}
}

function isLive(component: Component): boolean {
	// 通过 transcript-component-metadata 的 WeakMap 查到 TranscriptEntry，
	// 判定其是否处于 transient（streaming）状态。
	// 实现细节在 Phase C 启动 deep-dive 时确定。
	const entry = getTranscriptComponentEntry(component);
	return entry?.kind === "assistant" && entry.transient === true;
}
```

### Step 2: 测试 seam

断言：所有消息 finalized 时 `getNativeScrollbackLiveRegionStart()` 返回 `undefined`；一条 assistant streaming 时返回该消息起始行；streaming 结束后返回 `undefined`。

### Step 3: 提交

```bash
git add apps/kimi-code/src/tui/components/chrome
git commit -m "feat(kimi-code): report native scrollback seam from transcript container"
```

---

## Task 2: 废弃 rendered sliding window

**Files:**
- Modify: `apps/kimi-code/src/tui/utils/transcript-window.ts`
- Modify: `apps/kimi-code/src/tui/kimi-tui.ts`（`appendTranscriptEntry` / `trimTranscriptWindow`）

### Step 1: 拆分 logical window 与 rendered window

把 `trimTranscriptWindow` 改为只裁剪 `transcriptEntries`（logical），**不**调用 `transcriptContainer.removeChild` 销毁 rendered children：

```ts
function trimTranscriptWindow(state: TUIState): void {
	// 保留：裁剪 logical entries（控制 LLM context）
	const maxTurns = state.options.transcriptWindowTurns ?? 50;
	while (logicalTurnCount(state.transcriptEntries) > maxTurns) {
		state.transcriptEntries.shift();
	}
	// 移除：不再销毁 rendered children（让它们 commit 进 native scrollback）
	// 旧：while (transcriptContainer.children.length > ...) transcriptContainer.removeChild(...)
}
```

### Step 2: 处理 `transcriptEntries` 与 rendered children 的映射

`getTranscriptComponentEntry`（WeakMap）需要容忍"entry 被裁剪但 component 仍在 rendered 树里"的情况（返回 undefined）。`isLive`（Task 1）需处理 entry 不存在的情况（已 commit 的 entry 不在 logical window 里 → 视为 byte-stable）。

### Step 3: 测试

断言：超过 50 轮后，`transcriptEntries.length` 被裁剪，但 `transcriptContainer.children.length` 不减少（旧行保留）；账本引擎的 `committedRows` 单调增长。

### Step 4: 提交

```bash
git add apps/kimi-code/src/tui/utils/transcript-window.ts apps/kimi-code/src/tui/kimi-tui.ts
git commit -m "refactor(kimi-code): stop destroying rendered transcript rows; let them commit to scrollback"
```

---

## Task 3: `mergeCurrentTurnSteps` / `StepSummary` append-only

**Files:**
- Modify: `apps/kimi-code/src/tui/kimi-tui.ts`（`mergeCurrentTurnSteps`）
- Modify: `apps/kimi-code/src/tui/controllers/streaming-ui.ts`

### Step 1: 改 `mergeCurrentTurnSteps` 为 append-only

把"替换已渲染 step 为 StepSummary"改为"追加一个 StepSummary 行"：

```ts
function mergeCurrentTurnSteps(state: TUIState): void {
	const steps = collectCompletedSteps(state.currentTurn);
	if (steps.length < MERGE_THRESHOLD) return;
	// 不再：transcriptContainer.children[idx] = new StepSummaryComponent(steps)
	// 改为：追加一个 summary（旧 step 留在 scrollback）
	const summary = new StepSummaryComponent(steps, /* collapsed */ true);
	transcriptContainer.addChild(summary);
	state.transcriptEntries.push({ kind: "step-summary", steps });
}
```

### Step 2: `StepSummaryComponent` 支持 collapsed-by-default

summary 默认折叠（一行"已折叠 N 个步骤"），展开时作为 live region 内的临时内容（不进入 scrollback）。

### Step 3: 测试

断言：merge 后旧 step 组件仍在 `transcriptContainer.children` 里（未被替换）；summary 是新增的最后一个 child；账本审计不会因此触发大规模 resync（旧 step 在 byte-stable 区，summary 在 live 区）。

### Step 4: 提交

```bash
git add apps/kimi-code/src/tui/kimi-tui.ts apps/kimi-code/src/tui/controllers/streaming-ui.ts
git commit -m "refactor(kimi-code): make step summary append-only under ledger renderer"
```

---

## Task 4: `setNativeScrollbackCommittedRows` 优化（跳过已 commit 块）

**Files:**
- Modify: `apps/kimi-code/src/tui/components/...`（大型 transcript 子组件，如 `AssistantMessageComponent`）

### Step 1: 利用引擎的 `setNativeScrollbackCommittedRows` 信号

引擎在 compose 每个 child 前调用 `child.setNativeScrollbackCommittedRows(rowsInScrollback)`。子组件可用它跳过"已经在 immutable scrollback 里"的块的重新布局：

```ts
class AssistantMessageComponent implements NativeScrollbackCommittedRows {
	#committedRows = 0;
	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = rows;
	}
	render(width: number): string[] {
		// 前 #committedRows 行已在 scrollback，直接复用上次的缓存（不重排 markdown）
		if (this.#committedRows > 0 && this.#cachedLines) {
			return this.#cachedLines; // 或 slice 出未 commit 的尾
		}
		// ... 正常渲染
	}
}
```

### Step 2: 测试

断言：已 finalize 的 assistant 消息在后续帧不重排 markdown（render 调用计数稳定）。

### Step 3: 提交

```bash
git add apps/kimi-code/src/tui/components
git commit -m "perf(kimi-code): skip re-rendering committed transcript blocks"
```

---

## Task 5: 组件级渲染（partial roots）+ loader 接入

**Files:**
- Modify: `packages/pi-tui/src/ledger/engine.ts`
- Modify: `packages/pi-tui/src/tui.ts`
- Modify: `apps/kimi-code/src/tui/...`（loader）

### Step 1: 引擎补 `requestComponentRender` + `#resolvePartialComposeRoots`

在 `LedgerTuiEngine` 新增：

```ts
	#componentRenderTargets = new Set<Component>();
	#partialComposeRoots: Set<Component> | null = null;

	public requestComponentRender(component: Component): void {
		this.#componentRenderTargets.add(component);
		// 由 TUI 的 scheduleRender 触发 doRender；doRender 检查 targets
	}

	#resolvePartialComposeRoots(_width: number, _height: number): Set<Component> | null {
		if (this.#componentRenderTargets.size === 0) return null;
		if (this.#frameSegments.length === 0) return null; // 首帧必须全量
		const roots = new Set<Component>();
		for (const target of this.#componentRenderTargets) {
			for (const seg of this.#frameSegments) {
				if (seg.component === target || subtreeContains(seg.component, target)) {
					roots.add(seg.component);
				}
			}
		}
		return roots.size > 0 ? roots : null;
	}
```

`#composeFrame` 改为支持 `partialRoots`（reuse 未触及 root 的 `previous.lines` + seam，见 OMP `render()` 的 `reuse` 分支，Phase A Task 4 留的桩）。

### Step 2: `TUI.requestComponentRender` 暴露

```ts
requestComponentRender(component: Component): void {
	if (TUI.LEDGER_ENABLED) {
		const engine = this.getLedgerEngine();
		engine.requestComponentRender(component);
		this.requestRender(); // 触发调度
	} else {
		this.requestRender();
	}
}
```

### Step 3: loader 切到 `requestComponentRender`

在 loader 动画帧回调里（`kimi-tui.ts:919` 附近、`tui-state.ts:72-74` footer spinner）：

```ts
// 旧：this.state.ui.requestRender();
this.state.ui.requestComponentRender(this);
```

### Step 4: 测试

pi-tui 侧：`requestComponentRender(loaderRoot)` 不重渲 transcript root（render 计数）。app 侧：loader 转动时 transcript 不重排。

### Step 5: 提交

```bash
git add packages/pi-tui/src/ledger/engine.ts packages/pi-tui/src/tui.ts apps/kimi-code/src/tui
git commit -m "perf: component-scoped render for loader to avoid full-tree repaints"
```

---

## Task 6: ImageBudget 实装（替换 Phase A 桩）

**Files:**
- Modify: `packages/pi-tui/src/components/image.ts`
- Modify: `packages/pi-tui/src/ledger/engine.ts`（接入 ImageBudget）

### Step 1: 实装 `ImageBudget`

```ts
export class ImageBudget {
	private live = new Map<number, { lastUsed: number }>();
	constructor(private readonly cap: number, private readonly onPurge: () => void) {}
	beginPass(): void { /* reset per-frame seen set */ }
	endPass(): void { /* demote images not seen this frame */ }
	observe(id: number): void { this.live.set(id, { lastUsed: Date.now() }); }
	takePurgeIds(): number[] {
		if (this.live.size <= this.cap) return [];
		const sorted = [...this.live.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const toPurge = sorted.slice(0, this.live.size - this.cap).map(([id]) => id);
		for (const id of toPurge) this.live.delete(id);
		return toPurge;
	}
}
```

### Step 2: 引擎接入

`#composeFrame` 前后调 `imageBudget.beginPass()/endPass()`；`#emitFullPaint`/`#emitUpdate` 用 `takePurgeIds()` 生成 kitty `d=I` purge 序列。

### Step 3: 测试

断言：超过 cap 的旧图像被 demote 为文本，purge 序列发出。

### Step 4: 提交

```bash
git add packages/pi-tui/src/components/image.ts packages/pi-tui/src/ledger/engine.ts
git commit -m "feat(pi-tui): bound inline image store with ImageBudget"
```

---

## Task 7: 真实 app 验证

### Step 1: 全量测试

Run: `pnpm --filter @moonshot-ai/kimi-code test`
Run: `cd packages/pi-tui && node --test test/*.test.ts`
Expected: 全绿。

### Step 2: 手动会话验证

启动 CLI（默认 ledger）跑一个长会话：
- 流式 assistant 消息正常 reveal。
- 工具调用 spinner 不引起 transcript 整树重渲（肉眼无闪烁）。
- resize 不闪屏、scrollback 保留。
- 超过 50 轮后旧消息仍可在 scrollback 里看到（向上滚）。
- StepSummary 折叠/展开正常。
- 图片正常显示，超 cap 后旧图 demote。

### Step 3: 性能对比

对比 Phase A 之前（legacy）与之后（ledger）的：
- 流式 token 的每帧 emit 字节数（应显著下降，scroll-append vs 全量 diff）。
- spinner 帧的 transcript 重排次数（应为 0，组件级渲染）。

### Step 4: 提交

```bash
git commit -m "chore(kimi-code): validate ledger renderer against real sessions"
```

---

## 验收总清单

- [ ] transcript seam 正确：streaming 时 live 边界在 assistant 消息起始，finalized 后 undefined。
- [ ] 超过 50 轮后 rendered children 不销毁，committedRows 单调增长。
- [ ] StepSummary append-only，旧 step 留在 scrollback。
- [ ] loader 转动不重渲 transcript。
- [ ] ImageBudget 超 cap 后 demote。
- [ ] 真实长会话无闪烁、resize 正常、scrollback 完整。
- [ ] 全量测试通过。

---

## Self-Review

**1. 覆盖：** seam（Task 1）、废弃 rendered window（Task 2）、StepSummary（Task 3）、commit 信号优化（Task 4）、组件级渲染（Task 5）、ImageBudget（Task 6）、真实验证（Task 7）。覆盖 Agent 5 报告的所有 app 接入点。

**2. 核心决策：** 决策 2/3（废弃 rendered window + StepSummary append-only）是 app 内存模型改动，已在"关键设计决策"明确，需 app 团队确认。这是 Phase C 唯一的产品/架构依赖。

**3. 占位：** Task 1 的 `isLive`、Task 5 的 `subtreeContains` 是设计级描述，Phase C 启动 deep-dive 时落实为逐行代码。非 TBD。

**4. 一致性：** `TranscriptContainer implements NativeScrollbackLiveRegion`（Task 1）与 Phase A 的 seam 接口一致；`requestComponentRender`（Task 5）补 Phase A 留的 partial roots 桩；`ImageBudget`（Task 6）替换 Phase A 的 no-op 桩。

**5. 风险：**
- 决策 2/3 若被 app 团队否决（比如必须保留替换式 StepSummary），回退到"依赖审计重新锚定"（功能正确但有 scrollback 重复）。
- 废弃 rendered window 后，`getTranscriptComponentEntry` 的 WeakMap 需容忍 entry 被裁剪（Task 2 Step 2 已处理）。
- 长会话内存：账本只持 window + committedPrefix 引用，不随会话线性增长（决策 2 已论证）。
