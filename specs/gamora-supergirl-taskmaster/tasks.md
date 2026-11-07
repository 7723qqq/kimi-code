# Tasks — 关联记忆的完整优化计划

设计与需求见同目录 `design.md` / `requirements.md`。每个任务都带可运行的验收条件。

公共验证命令（各任务的验收在此基础上追加）：

```
cd packages/agent-core-v2 && bun run typecheck
cd packages/agent-core-v2 && bun test --isolate test/features/associativeMemory
cd /d/kimi/kimi-code && bun run lint && bun run check:no-comments && bun run check:boundaries
```

---

## T1 — 可及性纯函数

**做**：在 `features/associativeMemory/` 新增 `accessibility(atom, edges, now, params): number`，按 `design.md §2` 的组合公式实现；同分以 id 断序，保证确定性。

**验收**
- 新增 `test/features/associativeMemory/accessibility.test.ts`，至少三条：
  1. 同 `lastActivatedAt` 下，入射边权重和大的原子分数更高；
  2. 同结构下，更久未用的原子分数更低；
  3. `pinned` 不影响分数（排除由调用方处理），且相同输入两次调用返回完全相同的数值。
- `bun run typecheck` 通过。

---

## T2 — 显著性进入召回打分

**做**：`activate.ts` 的 termSeeds 计算里把 `baseWeight` 作为有序放大因子（增益封顶常量）。

**验收**
- 新增 `test/features/associativeMemory/salience.test.ts`：
  1. 两条文本几乎相同的笔记（词集相同、仅措辞不同），一条 `pin` 后，`recall` 首位是它；
  2. 该断言在移除放大因子后失败（反向验证，提交说明里写清）；
  3. 一条**未被 pin 但被多次显式召回**的记忆，仍能超过一条只 pin 一次的弱记忆（证明"封顶生效、pin 不是霸榜开关"）。
- 三档召回门禁（easy/clustered/sparse）全部仍通过。

---

## T3 — 显著性进入衰减

**做**：`decay.ts` 的 `applyDecay` 在既有 LTP 因子之后叠加端点 `baseWeight` 的影响，使高显著性连接有效年龄更小。

**验收**
- `decay.test.ts` 追加两条：
  1. 同年龄、同 `strengthenCount` 下，端点 `baseWeight` 更高的边权重更高；
  2. 高 `baseWeight` 的边在 365 天后仍然 `0 < weight < 1`（不冻结）。
- 既有 LTP 两条断言不回归。

---

## T4 — 淘汰改为按可及性

**做**：`service.ts` 的 `enforceBudgets` 用 T1 的 `accessibility` 排序替换 `lastActivatedAt` 升序。

**验收**
- `eviction.test.ts` 追加一条对比断言：在容量只允许保留 1 条时，**高连通、刚被召回过的旧原子存活**，而**孤立的、从未使用的新原子被退役**。
- 既有两条断言不回归：淘汰写 `ids` 审计、退役项对 `includeHistory` 可见。
- 三档召回门禁不退化。

---

## T5 — 显著性可观测

**做**：`RecallTraceNode` 增加可选 `salience`；`explain` 透出；`stats` 增加一行显著性分布（min/median/max），键名沿用现有风格。

**验收**
- `test/features/associativeMemory/` 中新增或扩展一条断言：`explain` 的返回里存在 `salience` 字段，且与 `list({kind:'atom'})` 里的 `baseWeight` 一致。
- `check:t-coverage` 通过（若新增 i18n 键）。

---

## T6 — 死状态清理

**做**：按 R4 删除或启用 `note.atomIds`；`baseWeight` 依 T2/T3 的落地情况保留或删除。

**验收**
- `rg -n "\.atomIds" packages/agent-core-v2/src/features/associativeMemory` 只剩 `concept.atomIds`（概念成员）与返回值字段，不再有 `note.atomIds`。
- 新增一条 `rebuild` 断言：写入 → 重建 → 仍能召回（证明不依赖已删字段）。
- `bun run typecheck`、`bun run lint`（0 error）通过。

---

## T7 — 概念排名的量化与决定

**做**：按 `design.md §3` 落地测量与判据。

**验收**
- 新增 `test/features/associativeMemory/conceptRanking.test.ts`：3 组"跨 ≥3 成员"的 cue，断言"概念进入前 3"，并把"是否首位"的比例作为诊断输出。
- 若首位比例 ≥ 2/3，把断言收紧为"首位"；否则在 `tools/memoryGraph.md` 写明概念不保证优先，并在测试里保留诊断值。
- 任务产出必须包含一句明确的结论（改写描述或收紧断言），不允许两个都不做。

---

## T8 — 干扰测量（模式分离的前置）

**做**：按 `design.md §5` 构造"相似但结论冲突"的语料并测量三种现象：误合并、互相压制、双双缺席。

**验收**
- 新增 `test/features/associativeMemory/interference.test.ts`，对每类现象各一条断言；断言写成"期望行为"（两条都应可召回），当前若失败则该任务转为"实现分离"。
- 若全部通过（未观察到干扰），在测试文件里以用例名表达结论（如 `keeps two conflicting but similar memories retrievable`），**不新增生产代码**。
- 若失败，按 `design.md §5` 第 3 步实现分离条件，并保持三档门禁不退化。

---

## 顺序

T1 → (T2, T3 并行) → T4；T5 可与 T2/T3 并行；T6 依赖 T2/T3 结论；T7、T8 独立，可最后做。

## 完成判据

1. T1–T8 各自的验收断言全部通过。
2. 三档召回门禁（easy 1.000 / clustered 0.500·0.722 / sparse 0.833·0.583）不退化。
3. `rg` 复核死状态：`baseWeight`、`note.atomIds` 要么有读者、要么不存在。
4. 记忆相关测试全绿；`typecheck`、`lint`（0 error）、`check:no-comments`、`check:boundaries`、`check:deep-imports`、`check:t-coverage` 全绿。
