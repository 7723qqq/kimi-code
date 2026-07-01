# pi-tui 改造交接（Phase B 完成 / Phase C 进行中）

> 接手 agent 请先读本文，再读 `plan/` 下的阶段计划（phase-b / phase-c）和 `research.md`（oh-my-pi 调研）。本文记录已完成的工作、当前状态、待决事项和下一步。

---

## 0. TL;DR（当前状态）

- **分支：** `chore/upgrade-pi-tui-0.78.1`（非 main，可直接提交）。工作树干净，仅 `plan/`、`research.md`、`handoff.md` 未跟踪（不要提交这些）。
- **Phase B（终端基础设施）：✅ 全部完成**（6 task + 整阶段 review + 收尾复审，全部通过）。
- **Phase C（App 层接入）：🟡 进行中**。Task 1/2/3 **已完成 + 通过 review**；Task 5 **刚开始即被用户中断**（未实施）；Task 6/7 未开始；Task 4 经用户确认**推迟到 Phase D**。
- **测试：** pi-tui `node --test packages/pi-tui/test/*.test.ts` **753/753**；app `pnpm --filter @moonshot-ai/kimi-code test` 全绿；typecheck（pi-tui + kimi-code）均通过。
- **下一步：** 继续 Phase C Task 5（组件级渲染 partial roots + loader 接入）。

---

## 1. 工作流背景

按 `superpowers:subagent-driven-development` 技能执行：每个 Task 派 **实现者（coder）→ spec compliance reviewer（coder）→ code quality reviewer（coder）**，串行；质量审查若不通过则实现者修复后**重审**。对设计级 scaffold 先派 **plan agent 做 deep-dive** 逐字提取机制，再交实现者。

**关键约束（每个提交都遵守）：**

- 语义化提交（`feat`/`fix`/`refactor`/`test`/`docs`/`perf`/`chore`，scope 为 `pi-tui` 或 `kimi-code`）。
- **绝不**加 co-author，**绝不**在任何地方出现 "claude" 字样。
- 只暂存本次改动的文件；`plan/`、`research.md`、`handoff.md` 保持未跟踪。
- Node-pure：禁止 `Bun.*`、FFI、`pi-natives`、`pi-utils`；`Bun.env`→`process.env`。
- 账本引擎仍在 `PI_TUI_ENGINE=ledger` 开关后（Phase A Task 11 的"切默认"未做），**保持现状，不要切默认**。
- `apps/kimi-code` 必须通过 `@moonshot-ai/kimi-code-sdk` 消费核心能力，**不**直接依赖 `@moonshot-ai/agent-core`。
- app 侧 TUI 改动遵循 `.agents/skills/write-tui/SKILL.md` + `apps/kimi-code/AGENTS.md`（`printableChar()` 比可打印键、`chalk.hex(colors.<token>)` 上色，CI guard）。

**验证命令：**

```bash
# pi-tui
cd packages/pi-tui && node --test test/*.test.ts
pnpm --filter @moonshot-ai/pi-tui typecheck

# app（vitest；--filter 下路径要包相对）
pnpm --filter @moonshot-ai/kimi-code exec vitest run test/tui/<file>.test.ts
pnpm --filter @moonshot-ai/kimi-code typecheck
```

**参考实现源（只读对照）：** `/Users/moonshot/Desktop/moonshot/oh-my-pi/packages/tui/src/`。

---

## 2. Phase B（终端基础设施）—— ✅ 全部完成

15 个提交（BASE `7418b035`）：

| Task | 提交 | 内容 |
|---|---|---|
| 1 | `8ff1ced5` `c41edab4` | 终端能力表 `terminal-capabilities.ts` + 注入引擎（sync/image/ED22 走 caps） |
| 2 | `62b414a2` `a077db20` | DA1 哨兵探测 FIFO + DECRQM（`terminal-probe.ts`）+ 可变 `ProcessTerminalCapabilities` + `engine.refreshSyncFraming()` |
| 3 | `273fd0ad` `90a9da7c` | Headless 模式（`#safeWrite` 唯一出口、`start()` 早返回） |
| 4 | `437492eb` `fc310cc2` `c037f1bc` | Resize viewport defer（alt-screen fast path + 120ms settle，ledger-safe） |
| 5 | `539d6396` `c04635da` `d7c822f7` | 输入鲁棒性（stdin-buffer partial-hold + paste watchdog + bracketed-paste）+ coalesced Escape 修复 + fresh-escape Critical 修复 |
| 收尾 | `8262da57` `d83afaf1` `7a2a7e55` | 探测字节防泄漏 + probe→sync 集成测试 + stdin-buffer 定时器 flake 稳定 |

**Phase B 中解决的几个真问题（接手须知）：**

- **kitty 查询与探测 FIFO 冲突：** 我们 `terminal.ts` 已有 `\x1b[>7u\x1b[?u\x1b[c]`，若再跑探测会让键盘 owner 多发 `CSI c` 导致 FIFO 失同步——已拆分为 `start()` 只 push `\x1b[>7u`、探测的第一个探测 `\x1b[?u\x1b[c]` 作为唯一 kitty 查询。改探测/键盘逻辑时别再引入重复 `CSI c`。
- **CMUX/TERM 让 mux 检测恒为真：** `isMultiplexerSession()` 看 `TMUX/STY/ZELLIJ/CMUX_*/TERM`。任何 mux 相关测试必须显式清理这些 env（snapshot/restore），否则非 mux 用例变空壳。见 `test/resize-defer.test.ts` 的 `MUX_ENV_KEYS`（含 `TERM`）。
- **WezTerm coalesced Escape 回归：** 移植 OMP `stdin-buffer.ts` 后，`\x1b\x1b[27;129:3u` 被合并成一个 meta-CSI token，我们的 `keys.ts` 不识别、Escape 失灵。调研发现 OMP 的 `keys.ts` 委托 Rust native（`keys.rs`）且把合并形式解析成 `alt+<inner>`，照抄既不现实也修不了 Escape。改用**方案 (b)-minimal**：`keys.ts` `matchesKey` 的 `escape` 分支加一条窄规则（剥前导 ESC 后递归，仅当内层本身也是 Escape 才认），~12 行，不误伤 `\x1b\x1b[A`（alt+up）。
- **fresh-escape Critical bug：** stdin-buffer 在事件循环卡顿 + 输入洪流时，fresh escape 分支会重 hold 而非 flush，导致 stale partial 与新按键合并丢键。修复：force-flush stale partial + 幂等 `#armFlushTimer`，带确定性复现测试（回退后 8/8 复现丢键 `["\x1b[<\x1b[A]"]`）。
- **探测字节漏进编辑器**（违反计划明确目标）：DA1 FIFO 的核心目的就是防这个。已在 terminal negotiation gate 过滤 DECRPM/OSC11（`parseKeyboardProtocolNegotiationSequence`），不让它们到 `forwardInputSequence`。
- **测试 flake：** Task 5 两段式 flush timer（10ms + `setTimeout(0)`）让旧测试的 `wait(15)` 余量太紧——提到 `wait(50)`。

**Phase B 范围外 / 后续跟进（已刻意不做）：**

- kitty 25ms 去重窗口（`#pendingKittyPrintableAtMs`）：sibling fix。
- `components/input.ts` 单行 input 的 paste 解码：目前完全不解 re-encoded control。
- 引擎 resize/mux 走 `#caps` 的统一：当前仍读 `process.env`。
- in-band resize（`?2048h`）/ appearance push（`?2031h`）的启用：探测已产出字段但未启用。
- Phase A Task 11（切 ledger 为默认）：未做，且本阶段不做。

---

## 3. Phase C（App 层接入）—— 🟡 进行中

计划：`plan/2026-06-30-pi-tui-app-integration-phase-c.md`。改动集中在 `apps/kimi-code/src/tui/` + `packages/pi-tui/src/ledger/` + `packages/pi-tui/src/components/image.ts`。

### 3.1 已确认的产品/架构决策（用户拍板）

1. **决策 2（transcript 内存模型）：废弃 rendered sliding window。** 旧行不销毁、commit 进 native scrollback；组件对象 + renderCache 随 turn 增长（Task 4 可在 commit 后清 cache 缓解）。匹配 OMP 模型。
2. **Task 1 live 边界：整个当前 turn 起点**（用现成 `isTurnBoundaryComponent`，user-message 组件 = turn 起点）。live 覆盖整个当前 turn（thinking/工具/assistant），零抖动。代价：长 turn 的 commit 推迟到 turn 结束。
3. **决策 3（StepSummary）：append-only。** 旧 step 留 scrollback，summary 作为当前 turn 末尾的新行追加；summary 不进 `transcriptEntries`（不进 LLM context）；`mergeAllTurnSteps` 一并改。
4. **Task 4（`setNativeScrollbackCommittedRows` 优化）：推迟到 Phase D。** 其"跳过重排"收益已被现有 render cache + 引擎 chainStable 覆盖，实际价值只是 commit 后清 cache 的内存优化。

### 3.2 计划与代码的出入（deep-dive 校正，接手须知）

1. **`ImageBudget` 桩不存在**——`image.ts` 只有 `Image` 类，Task 6 是从零新建。
2. **`@moonshot-ai/pi-tui` 没导出 seam 子路径**——计划里的 `from "@moonshot-ai/pi-tui/ledger/seam"` 会编译失败；已把 seam 类型加到 `packages/pi-tui/src/index.ts` 导出（Task 1 已做）。
3. **`TranscriptEntry` 没有 `transient` 字段**——`transient` 只在 `AssistantMessageComponent` 私有 `lastTransient`。但 Task 1 用 turn-boundary（`isTurnBoundaryComponent`），不依赖 `transient`。
4. **`StepSummaryComponent` 已经是永远折叠单行**——Task 3 的"collapsed-by-default"现状已满足，不用新增 UI。
5. **`#frameSegments` 只追顶层 child**——partial roots 粒度是顶层容器，所以 Task 5 对 **activity spinner** 有收益（跳过 transcript 重渲），对 transcript 内部 spinner 收益小。

### 3.3 逐 Task 状态

| Task | 主题 | 提交 | 状态 |
|---|---|---|---|
| 1 | TranscriptContainer seam（turn 边界）+ seam 导出 | `9c166d8d` | ✅ 实现 + spec ✅ + quality ✅ |
| 2 | 废弃 rendered sliding window | `db719a88` + `2d1cad56`（注释修正） | ✅ 实现 + spec ✅ + quality ✅ |
| 3 | StepSummary append-only | `fe16e74e` + `a5614cd6`（over-counting 修复） | ✅ 实现 + spec ✅（发现 over-counting）+ 修复 |
| 5 | 组件级渲染（partial roots）+ loader | — | ⬜ **刚开始即被用户中断，未实施** |
| 6 | ImageBudget 实装 | — | ⬜ 未开始 |
| 7 | 真实 app 验证 + 整阶段 review | — | ⬜ 未开始 |

### 3.4 Phase C 中解决的真问题（接手须知）

- **Task 3 over-counting bug（重要）：** `mergeCurrentTurnSteps` 在每次 `appendTranscriptEntry` 都跑（`kimi-tui.ts:~1743`）。append-only 后旧 step 仍在树里，每帧被 `existingSummary.addCounts(...)` 重复计入 summary（计数随每次 append 膨胀）。修复：给 `StepSummaryComponent` 加 `setCounts(thinking, tool)`（替换而非累加），`mergeCurrentTurnSteps` 每帧**重算当前 overflow 总数并 set**（幂等）。`mergeAllTurnSteps`（replay 调一次）不受影响，仍用 `addCounts`。测试已强化（回退 `addCounts` → 4，恢复 `setCounts` → 2/3，可捕获回归）。
- **Task 2 metadata 保留：** 废弃销毁后，旧组件仍在 `transcriptContainer.children`，其 metadata（WeakMap，key=组件）随之保留（`getTranscriptComponentEntry` 仍能解析，**不**返回 undefined）。这是预期的（WeakMap 随 children 增长，与组件对象同量级），不是泄漏。已在 `trimTranscriptWindow` 注释里写清楚（`2d1cad56`）。
- **seam 类型导出：** app 侧 `import type { NativeScrollbackLiveRegion } from "@moonshot-ai/pi-tui"`（从 `.` 导出，不是 `/ledger/seam`）。

---

## 4. 当前待办 / 注意事项

### 立即下一步：Phase C Task 5（组件级渲染 partial roots + loader 接入）

被用户中断的 implementer prompt 已设计好，要点：

- **引擎侧（`packages/pi-tui/src/ledger/engine.ts`）：**
  - `subtreeContains(root, target)` 模块级 helper（duck typing `children`，避免 engine→tui 循环 import）。
  - `#componentRenderTargets = new Set<Component>()`。
  - `public requestComponentRender(component)` 把 target 加进 set。
  - `#resolvePartialComposeRoots()`：把 target 映射到顶层 segment root（首帧必须全量，返回 null）。
  - `#composeFrame` reuse 分支：非 target 且 `previous?.component === child && previous.start === offset` 时**复用** `previous.lines` + seam（不调 `child.render`）。首帧全量。`chainStable` 可保守置 false。
  - `doRender()` compose 成功后 `this.#componentRenderTargets.clear()`。
- **`TUI.requestComponentRender`（`packages/pi-tui/src/tui.ts`，`requestRender` 后）：** ledger 下 `engine.requestComponentRender(component)`，然后 `this.requestRender()`。
- **loader（`apps/kimi-code/src/tui/components/chrome/moon-loader.ts:~101`）：** `this.ui.requestRender()` → `this.ui.requestComponentRender(this)`。`MoonLoader` 持有 `this.ui: TUI` 且 `extends Text`（是 Component）。
- **footer goal badge：不切**（低频，不在 transcript 子树，全量 requestRender 由 render cache 兜底）。
- **测试：** pi-tui 侧扩展 `ledger-engine-golden.test.ts`（A 重 render、B 不重 render）；app 侧扩展 `moon-loader.test.ts`（断言调 `requestComponentRender(this)`）。
- **提交：** `perf: component-scoped render for loader to avoid full-tree repaints`。

> 完整 prompt 在上一轮 assistant 消息里（被中断那条）。可直接复用。

### Phase C 剩余

- **Task 6（ImageBudget 实装）：** 从零新建（非替换桩）。要点：在 `packages/pi-tui/src/components/image.ts` 加 `ImageBudget` 类（beginPass/endPass/observe/takePurgeIds，cap 默认 8，可 `PI_TUI_IMAGE_CAP` 覆盖）；引擎 compose 前后 beginPass/endPass；emit 用 `takePurgeIds()` 生成 kitty `d=I` purge（`deleteKittyImage` 已存在于 `terminal-image.ts`）。**前置子任务：** 确认 `parseKittyImageHeader`/`encodeKitty` 是否带 `i=<id>`（budget 需从 line 解析 imageId）。
- **Task 7（真实 app 验证 + 整阶段 review）：** 跑 app + pi-tui 全量测试 + typecheck；手动验证（`PI_TUI_ENGINE=ledger` 启动 CLI：长会话 scrollback、流式 reveal、activity spinner 不重排 transcript、resize、StepSummary、图片 demote）。

### 遗留注意事项

- **`oxfmt` 未在本仓库强制**（`lint-staged` 只跑 `oxlint`，无 `format` script/CI）。各 task 实现者刻意**不**跑 `oxfmt`（会 reformat 大量无关文件）。如需 repo-wide 格式化，单独立项。
- **`pnpm --filter @moonshot-ai/kimi-code test -- <file>` 会跑整个套件**（不过滤）；聚焦单文件用 `pnpm --filter @moonshot-ai/kimi-code exec vitest run <path>`。
- **全局 `PI_TUI_ENGINE=ledger` 跑 pi-tui 全量会触发一个 Phase A 遗留失败**（`tui-render.test.ts` 的 maxLinesRendered 测试），非 Phase B/C 回归。本阶段验证用默认（legacy）跑全量；ledger 路径由各 ledger 测试自行 `withEnv` 打开。

---

## 5. 关键上下文

### 计划与调研

- 计划：`plan/2026-06-30-pi-tui-terminal-infra-phase-b.md`（Phase B）、`plan/2026-06-30-pi-tui-app-integration-phase-c.md`（Phase C）、同目录还有 phase-a/d。
- 调研：`research.md`（oh-my-pi vs 我们的差异地图、价值/effort 分级、风险）。
- oh-my-pi 源（只读对照）：`/Users/moonshot/Desktop/moonshot/oh-my-pi/packages/tui/src/`。

### 仓库约定（摘自根 AGENTS.md + write-tui skill）

- Node `>=24.15.0`，pnpm `10.33.0`（`engine-strict=true`）。
- 可选属性直接传 `undefined`，不用条件 spread；可选属性类型不必再 `| undefined`。
- 内部单参数方法不要改成 options 对象。
- 除包的 `index.ts` 外，其它 `index.ts` 优先 `export * from './module'`。
- app TUI 架构：`KimiTUI` 是 coordinator；控制器在 `controllers/`；组件在 `components/{chrome,dialogs,editor,media,messages,panes}/`；transcript 块在 `components/messages/`；streaming 在 `controllers/streaming-ui.ts`。

### 已完成的 deep-dive（结论在本文）

- Phase B Task 2（DA1 FIFO）、Task 5（stdin-buffer）—— 已落地。
- Phase C 整体 deep-dive（agent-30）—— 结论见 §3.1/§3.2，逐 task file:line 在当时的 plan-agent 输出里（如需复核可重派 plan agent 读 plan + 代码）。

---

## 6. 如何继续

1. 读本文 + `plan/2026-06-30-pi-tui-app-integration-phase-c.md` Task 5/6/7 + `apps/kimi-code/AGENTS.md`。
2. 跑 `git log --oneline 7418b035..HEAD` 确认当前在 `a5614cd6`（或更新）。
3. **继续 Phase C Task 5**：派一个 coder 实现（prompt 见 §4 上方，或上一轮被中断的那条），然后 spec + quality review。
4. Task 6（ImageBudget）→ Task 7（验证 + 整阶段 review）。
5. 整阶段 review 通过后：跑 `gen-changesets` 技能（默认 `minor`，不要自行 `major`）→ PR（英文标题 + 填模板，**不要**暴露 agent 身份或 claude 字样）。

如需用 subagent 继续，沿用 `superpowers:subagent-driven-development` 技能（实现者 → spec reviewer → quality reviewer）。
