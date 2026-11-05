# Tasks — 自训练关联记忆（associative memory）

设计见 `design.md`，需求见 `requirements.md`。

依赖：**T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8（可部分并行）→ T9 → T10 → T11 → T12 → T13**。T3/T4/T5/T6/T7/T8 是纯函数，可并行开发、各自单测。

全局验证命令（各任务验收在此基础上追加）：

```
cd packages/agent-core-v2 && bun test --isolate test/features/associativeMemory
bun run check:no-comments
bun run lint
bun run typecheck
```

---

## T1 — flag、类型、参数

新增 `features/associativeMemory/flag.ts`（照 `features/gitMemory/flag.ts`）、`types.ts`、`params.ts`。

**验收：**

- `associative_memory` 默认 `false`；`KIMI_CODE_EXPERIMENTAL_ASSOCIATIVE_MEMORY=1` 时 `flags.enabled('associative_memory') === true`。
- `types.ts` 含 `NodeType`（含 `'procedure'` 预留）、`EdgeKind`（含 `'inhibits'` 预留）、`Atom`/`Concept`/`Edge`/`NoteRecord`/`Cooccurrence`，且 `Atom`/`Concept` 含 `suppressed`、`validFrom`/`validUntil`、`confidence`；`Concept` 含 `labelSource`、`load`、`readiness`。
- `params.ts` 导出 §12 参数表全部默认值。
- `bun run check:no-comments` → OK。

## T2 — store：MiniDb 持久化 + 笔记追加 + 重放重建

新增 `store.ts`：按项目（`scopeKey`）一个 MiniDb 实例；笔记追加即写；图记录读写；`rebuildFromNotes(scopeKey)` 从笔记重放。

**验收（`test/features/associativeMemory/store.test.ts`）：**

- 同一 `scopeKey` 两次 open 复用同一实例；不同 `scopeKey` 互不可见（`listAtoms('A')` 不返回 `B` 的原子）。
- 追加笔记后 `getNote(id)` 返回原文；删除图记录后 `rebuildFromNotes` 能从笔记重放得到相同原子集。
- 损坏的图记录（非法 JSON）→ `rebuildFromNotes` 仍能重建，不抛。

## T3 — encode：笔记 → 原子

新增 `encode.ts`（纯函数）：`splitNote`、`encodeAtoms`。

**验收（`test/features/associativeMemory/encode.test.ts`）：**

- `splitNote` 按标题/段落/句子切分；超过 `maxAtomChars` 的段落被再切；空输入返回 `[]`。
- `encodeAtoms` 对每个原子：`terms` 为 `tokenize(text)`（复用 `@moonshot-ai/minidb` 的 `tokenize`），`vector` 为 TF-IDF 稀疏向量，`id` 为 `hash(scopeKey + noteId + ordinal)`。
- 相同输入两次编码 → 相同 `id` 与 `vector`（确定性）。

## T4 — train：Hebbian + 异突触降权 + 元可塑性

新增 `train.ts`（纯函数）：`hebbianConnect`。

**验收（`test/features/associativeMemory/train.test.ts`）：**

- 新原子与上下文原子间建立 `hebbian` 边，权重 = `baseLearningRate / (1 + strengthenCount) × nodeFactor`。
- 同一对原子二次强化：`strengthenCount` 递增，增量递减。
- 强化 `u→v` 后，`u` 的其他出边权重被负向修正（异突触），且修正量与 `Δw` 成比例。
- 节点出边权重总和超过 `outWeightBudget` 时按比例压缩。
- 与旧原子相似度 > `supersedeThreshold` 时建立 `supersede` 边，旧原子 `validUntil = now`、`suppressed = true`（不被删除）。

## T5 — decay：两段衰减 + 局部剪枝

新增 `decay.ts`（纯函数）：`applyDecay`、`pruneEdges`。

**验收（`test/features/associativeMemory/decay.test.ts`，注入时钟）：**

- `now - lastUsedAt ≤ powerLawDays`：权重按幂律/对数慢衰减（衰减后权重 > 同等时长指数衰减的权重）。
- `now - lastUsedAt > powerLawDays`：按 `halfLifeMs` 指数衰减。
- `pinned` 节点不衰减。
- 权重 < `pruneThreshold` 的边被剪枝；`suppressed` 节点权重不因衰减归零（两通道正交）。

## T6 — cluster：增量共现聚类 + 容量上限 + 分配准备度 + 确定性标签

新增 `cluster.ts`（纯函数）：`clusterIncremental`。

**验收（`test/features/associativeMemory/cluster.test.ts`）：**

- 共现计数 ≥ `clusterCoocThreshold` 且簇大小在 [`clusterMinSize`, `clusterMaxSize`] 内 → 生成概念，`labelSource = 'deterministic_v1'`，标签由中心度前 3 原子的文本/关键词构成。
- 簇大小 > `clusterMaxSize` → 强制分裂为多个概念。
- 已有高 `load` 概念的 `readiness` 低于新建节点 → 新簇优先分配给新建节点。
- 相同输入两次聚类 → 相同概念集（确定性，无随机）。

## T7 — activate：种子 + 稀疏扩散 + 预算 + 双时态过滤 + 冲突

新增 `activate.ts`（纯函数）：`activate`。

**验收（`test/features/associativeMemory/activate.test.ts`）：**

- 种子：向量相似度 Top-M 与词项命中节点被激活。
- 扩散：跳数 ≤ `spreadHops`；每跳权重 ×`spreadDecay`；`k(hop)=max(1, baseK - hop×kDecay)` 门控生效。
- 累计访问节点数 > `computeBudget` 时截断（结果稳定，不超限）。
- `isDeleted` / `suppressed` / `validUntil < now` 的节点默认不返回；`includeHistory: true` 时可返回历史区间。
- 冲突组（同一线索下互斥原子）一起返回，各带 `confidence`、`validFrom`、`conflictGroup`。

## T8 — render：召回结果 → 注入块

新增 `render.ts`（纯函数）：`renderRecall`。

**验收（`test/features/associativeMemory/render.test.ts`）：**

- 输出块含每个命中项的文本、来源（`noteId`）、按 `score` 降序。
- 超过 `maxTokens` 时按 `score` 截断（高分手滑保留）。
- 冲突组在输出中标注"冲突"。

## T9 — code：硬规则 + 默认 + 用户文件

新增 `code.ts`、`code/defaults.ts`、`code/load.ts`。

**验收（`test/features/associativeMemory/code.test.ts`）：**

- 内置默认含"凭据/密钥模式 → block_write"。
- `applyWriteRules`：命中密钥模式的笔记返回 `{ allowed: false, matches }`；普通笔记 `allowed: true`。
- `applyRecallRules`：命中 block_recall 的节点被过滤。
- `resolveConflict`：按"用户明确 > 推断；新 > 旧"排序，但不删除另一方（返回双方 + 排序）。
- `loadCode`：读取 `<homeDir>/associative-memory/code.md`（YAML frontmatter + 正文软指引），与默认合并；文件缺失时仅用默认。

## T10 — service + maintainer：编排 + reminder + 去重

新增 `service.ts`、`maintainer.ts`。

**验收（`test/features/associativeMemory/service.test.ts`）：**

- `writeNote(text)`：法典通过 → 编码 → Hebbian → 追加笔记 → maintainer 消费；返回 `atomIds`。
- 法典阻断 → `blockedByCode: true`，不产生原子。
- `recall(query)`：返回 `RecallResult`，含 `trace`。
- `pin`/`forget`：分别设置 `pinned` 与 `isDeleted`/`suppressed`。
- `stats()`/`explain()`：返回数量与 Recall Trace。
- reminder `associative_memory_signal`：新对话触发时用上一条用户消息召回并注入；与 gitMemory 注入按 id 去重（同一笔记不重复注入）。

## T11 — 工具 MemoryGraph

新增 `tools/memoryGraphTool.ts`、`tools/memoryGraph.md`。

**验收：**

- 工具注册名 `MemoryGraph`，actions `write` / `recall` / `pin` / `forget`；`sideEffect` 为 write。
- 工具描述 `.md` 引导模型"学到值得记住的东西时写"，不自动。
- flag 关闭时工具不注册。
- i18n：`toolsV2.memoryGraph.*` 键在 `en.ts`/`zh.ts` 补齐，`bun run check:t-coverage` 通过。

## T12 — 系统提示集成（${memory_code}）

改 `agentProfileCatalog/profile-shared.ts`（`systemPromptVars` 增加 `${memory_code}`）、`system.md` 增加对应段落；flag 关闭时渲染为 `''`。

**验收：**

- flag 开启且有软指引时，系统提示包含 `${memory_code}` 段落。
- flag 关闭时该段为空，`unresolvedPromptVariables` 不报未定义。
- `check:prompt-ownership` 通过。

## T13 — 集成测试与重建

新增 `test/features/associativeMemory/integration.test.ts`。

**验收：**

- 写一条笔记 → `recall` 能命中该原子（同项目）。
- 不同项目互不命中。
- 违反硬规则的笔记不入库。
- `supersede` 后旧原子区间关闭且被抑制；`includeHistory: true` 可召回。
- 删除图索引 → `rebuildFromNotes` → `recall` 结果一致。
- 并发写（多个 `writeNote` 同时）→ maintainer 串行消费后图状态一致、无重复原子。

## 第五轮收尾

### T14 — 审计日志（audit.ts）

新增 `src/features/associativeMemory/audit.ts`（JSONL 追加/读取）并接入 service 的写入过滤、召回过滤、pin/forget、supersede、embeddings、replay、rebuild、提议/批准、标签路径。

**验收：**

- `readAudit` 新的在前；缺失返回空；跳过损坏行；遵守 limit。
- 一次被拦截写入 + 一次 pin → `audit()` 含 `write_blocked` 与 `pin`，且 pin 在前。
- `export` 的 payload 含 `audit` 字段。

### T15 — 显式再巩固通路（reconsolidate）

service `reconsolidate(targetId|undefined, text)`：编码新证据 → 连到目标邻域 → 与目标相似度 > 0.5 时覆盖目标（仅目标，不含邻域）；`lastRecallIds` 支持无 id 时针对最近召回项。工具 action `reconsolidate`。

**验收：**

- 召回一条 → `reconsolidate(id, 更正值)` → 新原子入库、旧原子 `suppressed` 且区间关闭。
- 无 `id` 时针对最近一次召回项。
- 审计含 `reconsolidate` 与 `supersede`。

### T16 — 离线评测基准

新增 `src/features/associativeMemory/eval.ts`（`evaluateRecall` → hit@1/hit@5/MRR）、`test/features/associativeMemory/eval.test.ts`、`test/features/associativeMemory/eval.bench.ts`（真实 service + 合成语料，含 lexical 与 synonym 两类线索）。

**验收：**

- 单测覆盖全中/全不中/MRR/hit@5 边界/空输入/格式化。
- `bun test ./test/features/associativeMemory/eval.bench.ts` 打印每类与总体指标；lexical 线索 hit@5 > 0；synonym 类（无词面重叠）作为稀疏基线记录。

### T17 — 接线缺口

把 `stats`/`explain`/`rebuild` 暴露为工具 action；`resolveConflict` 经 `orderConflictGroups` 接入 `recall`。

**验收：**

- 工具 action 含 `stats`/`explain`/`rebuild`，输出可读。
- `orderConflictGroups`：同一冲突组内高置信/较新项排前，跨组保持分数顺序。
- `grep` 确认 `stats`/`explain`/`rebuild` 在工具中有调用点。

### T18 — spec 文档对齐

同步 `requirements.md`（边界项移入需求）、`design.md`（§10/§16）、`tasks.md`（本节）、`progress.md`。

**验收：**

- requirements 的"边界"不再包含已实现项；design §16 的"待办"为空。
- 四份文档描述与代码一致（无"未实现"标注残留）。
