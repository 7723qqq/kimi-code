# Progress

Spec: `specs/valkyrie-ravager-wolfsbane/`（requirements.md / design.md / tasks.md）
选定方案：**全量执行（推荐）**

## 状态总览

| 阶段 | 状态 |
|---|---|
| A 组 T1–T5（一致性） | ✅ 全部完成 |
| B 组 T6–T8（重复代码） | ✅ 全部完成 |
| C 组 T9–T17 / T16（可维护性 + 收尾） | ✅ 全部完成 |
| 第二轮：既有红灯修复 | ✅ A0.3 已修复 · A0.2 已消解 · A0.1 已按台账方案处理 |
| 第二轮：门禁收敛 | ✅ `scripts-wiring` 警告 10 → 6（余下全为既有 upstream-drift） |

动工前基线：`check-import-boundaries` OK 1710 files · `check-deep-imports` OK · `oxlint --quiet` 0 error / 6893 warning · `tools/review` 0 error / 10 warning · `oxfmt --check` 通过 · `check-no-comments` exit 1 / 154 违规（既有红灯）· 工作树有 2 个未提交 locale JSON 改动

三项既有红灯的最终状态：**A0.3 已修复**（`build:packages` 由 exit 1 → exit 0）、**A0.2 已消解**（随 T5 删除管线一并消失）、**A0.1 已按 baseline 台账方案处理**（`check:no-comments` 由 exit 1 → exit 0，且新增注释仍会拦住）。详见「第二轮：既有红灯修复」一节。


| 任务 | 对应条目 | 状态 | 备注 |
|---|---|---|---|
| T1 | A1 | ✅ 完成 | DEVELOP.md:166、:182 改写 |
| T2 | A2 | ✅ 完成 | 删 vis/server 死依赖；vscode alias 保留（经证实为传递依赖） |
| T3 | A3 | ✅ 完成 | node-sdk 导出两个常量；app 侧改导入 |
| T4 | A4 | ✅ 完成 | 删 `packages/agent-core` 排除项 |
| T5 | A5 | ✅ 完成 | 删 14 个 JSON + 生成器 + CI 步骤 + zig 条目 |
| T6 | B6+B7 | ✅ 完成 | 删 human/compaction；vitest 439 文件全绿 |
| T7 | B8 | ✅ 完成 | 删 scan-hardcoded.mjs（v1） |
| T8 | B9+B10 | ✅ 完成 | 删 3 个重复 dev 脚本；修正端口文档描述 |
| T9 | C11 | ✅ 完成 | loopService.ts 2374→2217；loopInternals.ts 提取 |
| T10 | C12 | ✅ 完成 | 测试 10122→9068（298 用例名逐一不变）；tool-call.ts 2733→2693 |
| T11 | C13 | ✅ 完成 | human/AGENTS.md（含双根 `#/` 解析说明） |
| T12 | C14 | ✅ 完成 | 无需改动（核对结论见下） |
| T13 | C15 | ✅ 完成 | 新增 `test:minidb` + DEVELOP.md 说明 |
| T14 | C16 | ✅ 完成 | 5 个脚本接入根 package.json |
| T15 | C17 | ✅ 完成 | 只读盘点；结论：无可清理项（206 条全部用户可见） |
| T16 | 收尾 | ✅ 完成 | lint/format 已修，全部门禁复核通过 |

## 最终门禁复核（T16）

| 门禁 | 结果 | 与基线对比 |
|---|---|---|
| `bunx oxlint --quiet`（改动文件） | 0 error / 221 warning | 修复了 3 处我引入的 unused import |
| `bunx oxlint`（全仓） | 0 error | 基线亦为 0 error |
| `bunx oxfmt --check`（改动文件） | All correct | 曾 8 个文件需格式化，已 `oxfmt` 修正 |
| `check-import-boundaries` | OK (1705 files) | 基线 1710；−5 = T6 删的 6 个 .ts + T9 新增 1 个 |
| `check-deep-imports` | OK | 同基线 |
| `agent-core-v2` typecheck | exit 0 | — |
| `apps/kimi-code` typecheck | exit 0 | — |
| `agent-core-v2` vitest | 439 文件 / 7838 passed / 15 skipped | **与基线逐项相同** |
| `cli` vitest | 270 passed / 3 skipped（4227 passed / 4 skipped） | 与基线相同（中途一次 1 failed 未复现，为 flake） |
| `tools/review` | 0 error / 10 warning / 0 info | 同基线；并清掉 2 条因 T6 失效的台账条目 |
| locale 三检查 | 均 exit 0 | — |
| `check-no-comments` | 154 违规（exit 1） | **既有红灯 §A0.1，未变** |
| 四个 T14 脚本退出码 | no-comments=1，其余 0 | 与改前逐一同值 |

改动规模：修改 20 个文件、新增 8 个、删除 24 个。

## 第二轮：既有红灯修复（继续推进）

在 16 项任务全部完成后，回头处理 `design.md` §A0 记录的三项既有红灯。

### A0.3 — 已修复 ✅（`build:packages` / `publish` 管线恢复绿灯）

**根因**（此前只记录现象，本轮定位到具体机制）：`packages/node-sdk/scripts/build-dts.mjs:120` 的
重写正则只覆盖 `#/…` 与 `@moonshot-ai/*`，**不覆盖 `#human/…`**。因此 tsc 产出的 89 个 `.d.ts`
中残留 31 种不同的 `#human/…` specifier，api-extractor 无法解析（`tokens.d.ts:1` 即其一）。

**改动**（最小化，11 行）：
- `build-dts.mjs:120` — 正则前置 `#human\/[^"']+` 分支。
- `build-dts.mjs:167` — `resolveSpecifier()` 新增 `#human/` 分支，解析到 `<pkgDir>/src/human/` 下。

**验证**：
- `cd packages/node-sdk && bun run build:dts` → exit 0，`API Extractor completed successfully`。
- `bun run build:packages` → **exit 0**（动工前为 exit 1）。
- 产出 `packages/node-sdk/dist/index.d.mts`（372 754 字节），其中 `#human/` 残留 = **0**。
- 独立脚本模拟重写：89 个文件 / 31 种 specifier 全部解析到真实存在的 `.d.ts`，**不可解析 = 0**
  （证明是「解析」而非「静默丢弃」类型信息）。

### A0.2 — 已消解 ✅

原本提交的 `apps/kimi-code/src/i18n/locales/{en,zh}.json` 改动，随 T5 删除该管线而一并消失
（两处 key 在已提交的 `.ts` 中均已存在，无信息损失）。

### A0.1 — 已按「baseline 台账」方案处理 ✅

**决策**：用户选择「加 baseline 台账」（而非「先搬文档再删」或「不动仅记录」）。

**改动**：
- `scripts/check-no-comments.mjs` — 新增台账读取与判定：按文件容忍既有计数，仅对**超出**计数的
  违规报错；同时报告「低于计数」与「不再匹配任何违规」的失效条目，使台账不会腐化。
  格式与仓库既有的 `tools/review/silent-catch-baseline.txt` 一致（`path  count`）。
- `scripts/no-comments-baseline.txt`（新增）— 20 条 `路径 计数`，头部说明这 154 处为何被保留
  （2026 DeepSeek adaptation 工作写入的设计约束注释）及重新生成计数的方法。
- `DEVELOP.md`「General Coding Rules」— 补充台账语义：新增注释仍会挂，应把依据搬进 `docs/`
  并下调计数，而不是往台账加新条目。
- `.github/workflows/ci.yml` — 注释改为「无**新增**注释；已评审的既有注释计在台账中」。

**为什么不是删注释**：这些注释陈述的是设计约束而非琐事——例如 `modelAdaptations.ts` 说明两个
token 常量为何必须独立（「a single endpoint change must not be able to move both」）、
`requester.ts:100` 说明 DeepSeek 为何要求整段推理历史（否则 HTTP 400）、
`modelAdaptations.ts:142` 说明 `##` 围栏切分为何记录 span 而非单个 offset。
删除会丢失依据，且其中相当一部分需先搬进 `docs/en/llm.md` 才能删（属内容改写）。

**变异测试**（证明护栏真的有效，而非把红灯藏起来）：
| 场景 | 期望 | 实测 |
|---|---|---|
| 对已达计数的文件**新增**一条注释 | exit 1 | ✅ exit 1，且精准报出该行 |
| **删除**一条被容忍的注释（低于计数） | 提示 rot | ✅ exit 0 并报 `no longer matching anything` |
| 新增一个**不在台账**的文件并写注释 | exit 1 | ✅ exit 1，报出新文件与行号 |
| 格式化脚本后重跑首个用例 | exit 1 | ✅ 行为不变 |

**验证**：`bun run check:no-comments` → exit 0，输出
`OK (2005 files, 154 accepted by scripts/no-comments-baseline.txt)`；
`bun run check:no-comments:counts` → 逐行输出 20 个文件的原始计数，与台账正文 `diff` **完全相同**；
`oxlint` 对改动脚本 0 error；`oxfmt --check` 通过；`tools/review` 0 error / 6 warning / **0 info**；
所有变异测试后工作树零残留。

## 第三轮：TUI Updates 面板高度上限与滚动（用户反馈）
用户反馈两点（截图）：「信息栏」高度无上限、全屏下应可滚动；提示词模块同样应可滚动。

### 调查结论

1. **无上限属实**：`notify-panel.ts` 的 `render()` 对正文不裁剪，头注释自我声明
   「Entries render at their natural height — the box adapts instead of truncating」，
   全仓无 `maxHeight`。面板越长越高，最终把编辑器与 footer 挤出屏幕。
2. **全屏滚动**：全屏下 transcript 本就可滚（`TranscriptView` 用
   `ScrollView{follow:'end',primary:true,overscroll:'chain',scrollbar:'auto'}`），
   但 `notifyPanelContainer` 是 dock 的兄弟节点、自身不滚动，超长时被挤压而非滚动。
3. **「提示词模块」**：用户确认「就是这个模块」，即截图中标题为
   `main · Updates 4/4 · ctrl+n` 的 Updates 面板。另查明 Ctrl+P 的
   `prompt-optimize-panel.ts` 已有行数上限（`room` 裁剪），不属此项。

### 用户决策

- 高度上限：**固定 12 行，且不超半屏**（取小者）
- 键盘：**↑/↓ 改为滚动当前更新**，翻条目迁移到别的键

### 实现

| 文件 | 改动 |
|---|---|
| `apps/kimi-code/src/tui/components/chrome/notify-panel.ts` | 新增 `MAX_VISIBLE_ROWS = 12`、`MIN_BODY_ROWS = 3`、`bodyBudget()`（终端高度未知时仍保留固定上限）、`scrollBy()`、`measureBodyHeight()`；`render()` 按预算切片并记录完整高度；标题增加 `+N lines` 提示；`blur()`/频道切换/翻条目均重置滚动 |
| `.../tui/components/editor/custom-editor.ts` | `onNotifyPanelKey` 联合类型与分发增加 `pageUp`/`pageDown` 及 `[`/`]` |
| `.../tui/controllers/notify.ts` | `handlePanelKey` 改为 `up/down` → 滚动、`pageUp/pageDown` → 翻条目；仅在状态真变时 requestRender |
| `.../tui/controllers/editor-keyboard.ts`、`.../tui/kimi-tui.ts`、`.../tui/tui-state.ts` | 同步键联合类型；把 `() => terminal.rows` 注入面板 |
| `src/i18n/locales/{en,zh}.ts` | 聚焦提示改为 `↑ ↓ scroll · [ ] update` |
| `docs/{en,zh}/reference/keyboard.md` | 新增面板内按键与高度上限说明（原文只写了 Ctrl+N） |
| `.changeset/notify-panel-height-cap.md` | 用户可见行为变更 |

### 过程中发现并修正的两个自身缺陷

1. **`PgUp`/`PgDn` 在全屏下已被占用**：`packages/pi-tui/src/tui-alt-screen.ts:800` 将
   `tui.altScreen.pageUp` 绑定到主滚动视图（transcript），面板无法取得该键。
   这解释了「regular 模式通过、fullscreen 模式失败」。故翻条目主键改为 **`[`/`]`**，
   `PgUp`/`PgDn` 仅在非全屏下同样接受。
2. **`+N lines` 会挤掉频道标签栏**：导致**未读圆点不可见**（`collects an unread dot…` 用例变红）。
   改为按「读者最不需要」的顺序降级（先丢 hint、再丢 `+N`、标签栏最后），未读信号优先保留。
3. 另一处实现缺陷：`scrollBy()` 原先依赖上一次 `render()` 记录的高度，首次渲染前调用无效；
   改为 `measureBodyHeight()` 按需测量。

### 验证

- `notify-panel.test.ts` 23/23（含新增 4 条：上限与 `+N` 提示、`scrollBy` 夹取、失焦回顶、终端预算）
- `notify.test.ts` 40/40（含 regular + fullscreen 双模式集成用例）
- `kimi-tui-message-flow.test.ts` 272/272
- **full cli 套件：270 passed | 3 skipped（4230 passed | 4 skipped）**，与改动前基线一致
- `apps/kimi-code` typecheck exit 0；locale 三检查 exit 0；`oxlint` 0 error；`oxfmt --check` 通过
- `tools/review` 0 error / 6 warning；`check:no-comments` OK


- `scripts-wiring` 警告 **10 → 6**：三个 agent-core-v2 manifest 生成器（`gen:config-manifest`、
  `gen:wire-manifest`、`gen:state-manifest`）产出**被跟踪**的产物、且 `stale-artifacts` 正是以
  它们为门禁，却没有任何可达入口能重新生成。新增根脚本 `gen:manifests` 后三条警告全部消失。
- `gen:contract-types` 的产物落在 gitignored 的 `.contract-types-tmp/`，不适用新鲜度门禁，属正当的
  手工工具，已按 `review` 的语义记入 `tools/review/scripts-wiring-baseline.txt`。
- 剩余 6 条警告**全部**是既有的 `upstream-drift`（上游有、本分支删除的文件），与本轮无关。
- `DEVELOP.md` 的 Root-level commands 补上 `gen:manifests` 与两个 boundary 检查。

**第二轮验证**：`build:packages` exit 0 · `check-import-boundaries` OK(1705) · `check-deep-imports` OK
· `review` 0 error / 6 warning / 0 info · `oxlint` 对改动脚本 0 error · `gen:manifests` 幂等（重跑无 diff）。

原报告称「206 个待发布条目说明发布节奏与提交节奏脱节，建议批量收敛」——**该判断有误**：
- 逐条检查 206 个 changeset 的正文，**0 条**以非用户可见动词开头（test/refactor/docs/chore/internal/typo）；抽样 12 条全部描述真实行为变更（如 `/copy` 命令、Antigravity 回退、审批预览限定 bash）。
- 累积时间：164 条来自 2026-08、42 条来自 2026-10。
- `CONTRIBUTING.md:257-258` 说明这是**既定设计**：changesets 是 changelog 来源、PR 必须带；仅在有意的发布前用 `pre-changelog` skill 剪枝。本 fork 的 release PR 已被注释掉（`CONTRIBUTING.md:254`），不会自动发布。
- 因此本条**不改动任何文件**（`git status .changeset` 为空），建议由「批量收敛」改为「保持现状，发布前按流程剪枝」。

## 各任务最终验证记录

- **T1** `grep -n "src/kosong" DEVELOP.md` → 空
- **T2** vis/server typecheck exit 0；build 成功（305.64 kB）；src/package.json/tsdown 无 kosong 残留
- **T3** tui 下无引擎 import（严格 grep 空）；app typecheck exit 0；node-sdk tsdown exit 0 且产物含两个常量；tool-call.test 121/121
- **T4** `grep "packages/agent-core\"" tsconfig.json` → 空；JSONC 可解析
- **T5** 跟踪的 locale JSON = 0；三个 locale 检查 exit 0；`zig build test` exit 0；review 0 error；check-web-assets OK(525)
- **T6** agent-core-v2 vitest 439 文件 / 7838 passed / 15 skipped；boundaries OK(1704)；typecheck exit 0
- **T7** 仅剩 v2 引用；`scan:hardcoded` 退出码语义未变（5 处既有发现）
- **T8** app scripts 无重复命令；`dev:kap-server` 全仓 0 引用；app typecheck exit 0
- **T9** vitest 439 文件 / 7838 passed / 15 skipped（与改前逐项一致）；boundaries OK(1705)；no-comments 仍 154
- **T10** 新老测试 full-name 集合逐一相同、298/298 通过；cli project 4227 passed / 4 skipped
- **T13** `bun run test:minidb` exit 0（44 passed / 1 skipped 文件，559 passed）
- **T14** 四个脚本退出码与改前一致（no-comments=1 为既有红灯，其余 0）；ci.yml 改调根脚本；review 0 error / 10 warning / 0 info
- **基线台账清理**：t6 删 `human/compaction` 后，`tools/review/orphan-exports-baseline.txt` 的 `createCompactionController` 条目失效，已移除


## T1 — 修正 `DEVELOP.md` 的 kosong 描述（A1）✅

改动文件：
- `DEVELOP.md:182` — 重写 kosong 段落：删除「`src/kosong/` keeps the DI/trait composition machinery」「its `contract/` directory is a thin re-export」两句；改为陈述 kosong 是冻结的旧内核、`agent-core-v2` 不导入它、provider/request 代码在 `packages/agent-core-v2/src/human/llm/`、v2 兼容边界是 `src/llm-adapter/`，并引用 `check-import-boundaries.mjs` 与 `docs/en/llm.md`、`cache-field-parity.test.ts`。
- `DEVELOP.md:166` — 目录清单注释 `kosong/ — LLM / provider abstraction layer` → `Frozen legacy LLM / provider kernel (published SDK + oauth only)`。

验证：
- `grep -n "src/kosong" DEVELOP.md` → 无输出 ✅
- `grep -n "kosong" DEVELOP.md` → 只剩 :166、:182、:415（:415 是 `packages/kosong/src/providers/` 的 lint 放宽说明，仍然准确）✅
- 无源码改动，未重跑测试 ✅
