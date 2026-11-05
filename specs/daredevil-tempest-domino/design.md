# Design — 自训练关联记忆（associative memory）

需求见 `requirements.md`。本文件给出落点、数据模型、写入/训练/召回/衰减机制、法典、核心接口与被否决的方案。

## 0. 一句话设计

**把经验编码成原子单元，用 Hebbian 共现学习出带权连接、随时间两段衰减，线索到来时以向量种子起步、沿连接做有预算的稀疏扩散、召回相关旧经验；法典约束全过程。**

```
模型写笔记 ──编码器(纯函数)──► 原子单元 + 词项 + 局部向量
                                      │
                              写入即训练(Hebbian)
                                      │
                 上下文窗口内活跃原子 ──连接──► 新原子
                                      │
                            共现统计 ──增量聚类──► 概念单元
                                      │
                              两段衰减 + 局部稳态 + 异步维护

线索(上一条用户消息) ──TF-IDF 种子──► 稀疏扩散(跳数+阻尼+门控+预算) ──► top-k ──► 注入
```

**Source of Truth 是笔记（原始经验文本）**；图（原子/概念/边/共现）是派生索引，可从笔记重放重建（event sourcing）。写入路径只追加、无锁；图更新由单写者串行消费。

## 1. 落点

```
packages/agent-core-v2/src/features/associativeMemory/
  flag.ts                     — flag: associative_memory
  types.ts                    — 全部记录与接口（见 §2、§16）
  params.ts                   — 全部可调参数（见 §12）
  encode.ts                   — 纯函数：笔记 → 原子（切分 + 词项 + 向量）
  train.ts                    — 纯函数：Hebbian + 异突触降权 + 元可塑性
  decay.ts                    — 纯函数：两段衰减 + 局部剪枝
  cluster.ts                  — 纯函数：增量聚类 + 容量上限 + 分配准备度
  activate.ts                 — 纯函数：种子 → 稀疏扩散 → top-k（含预算）
  render.ts                   — 纯函数：召回结果 → 注入块
  code.ts                     — 硬规则判定（写入/召回/冲突/保留）
  code/defaults.ts            — 内置默认硬规则 + 软指引正文
  code/load.ts                — 用户法典文件（YAML frontmatter）+ 合并默认
  store.ts                    — MiniDb 持久化 + 内存图索引（按项目）
  maintainer.ts               — 单写者后台 worker：消费变更、衰减/剪枝/聚类/落盘
  service.ts                  — 编排：write / recall / pin / forget / stats / explain；注册 reminder
  tools/memoryGraphTool.ts    — MemoryGraph 工具
  tools/memoryGraph.md        — 工具描述（prompt text）
```

测试：`packages/agent-core-v2/test/features/associativeMemory/*.test.ts`。

## 2. 数据模型

MiniDb 记录（按 key 前缀）：`atom:` / `concept:` / `edge:` / `note:` / `cooc:`。图在内存中持有；笔记追加即写，图更新由 maintainer 串行处理。

```ts
type NodeType = 'atom' | 'concept' | 'procedure';   // procedure 预留，v1 不用
type EdgeKind = 'hebbian' | 'cooccurrence' | 'concept' | 'supersede' | 'inhibits'; // inhibits 预留

interface Atom {
  id: string;                    // hash(scopeKey + noteId + ordinal)
  noteId: string;                // 属于哪条笔记（Episode 层）
  scopeKey: string;
  nodeType: 'atom';
  text: string;
  terms: string[];
  vector: Record<string, number>;// 稀疏 TF-IDF
  conceptId?: string;
  baseWeight: number;            // 重要性基值（独立于被召回次数）
  confidence: number;            // 置信度（来源/法典/反馈）
  pinned: boolean;               // 钉住：不衰减
  suppressed: boolean;           // 抑制态：可逆软遗忘，与衰减正交
  validFrom: number;             // 双时态：生效时间
  validUntil?: number;           // 双时态：失效时间（undefined = 仍有效）
  isDeleted: boolean;            // 软删除（显式 forget）
  createdAt: number;
  lastActivatedAt: number;
}

interface Concept {
  id: string;
  scopeKey: string;
  nodeType: 'concept';
  label: string;
  labelSource: 'deterministic_v1' | 'llm';  // 后置钩子预留
  terms: string[];
  vector: Record<string, number>;
  atomIds: string[];
  load: number;                  // 关联负载（分配准备度用）
  readiness: number;             // 1 / (1 + load / loadRef)
  suppressed: boolean;
  validFrom: number;
  validUntil?: number;
  createdAt: number;
  lastActivatedAt: number;
}

interface Edge {
  id: string;                    // `${from}>${to}`
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  strengthenCount: number;       // 被强化次数（学习率递减 + 元可塑性用）
  validFrom: number;
  validUntil?: number;
  createdAt: number;
  lastUsedAt: number;
}

interface NoteRecord {            // Source of Truth，可重放
  id: string;
  scopeKey: string;
  text: string;
  atomIds: string[];
  createdAt: number;
}

interface Cooccurrence {
  key: string;                   // 排序后的 `${a}|${b}`
  a: string; b: string;
  count: number;
  lastAt: number;
}
```

**双时态**：`validFrom`/`validUntil` 取代硬删除。被覆盖的记忆关闭区间（`validUntil = now`）而非删除；召回默认只返回当前有效的节点，`includeHistory: true` 时按时间窗口打开旧区间。

**抑制态**：`suppressed` 与权重衰减正交——落败的竞争记忆不被降权，只被标记为抑制；线索变化或竞争记忆失效时解除。

## 3. 写入路径（编码 → 法典 → 训练）

```
writeNote(text):
  1. 法典写入闸门（§7）：硬规则过滤 + 软指引（模型在工具描述/系统提示下自判）
  2. 编码：splitNote → atoms（词项 + TF-IDF 向量）
  3. 上下文激活集：时间窗口内活跃的原子 + 本笔记内共存原子
  4. Hebbian 连接：新原子 × 上下文原子（§3.1）
  5. 追加笔记事件（无锁）；图更新入队给 maintainer（§9）
```

### 3.1 Hebbian 连接

- **上下文激活集** = 最近 `contextWindowMs` 内 `lastActivatedAt` 的原子 ∪ 本笔记内其他原子。**不做全图扫描**，只查窗口内原子（内存索引按 `lastActivatedAt` 有序）。
- **学习率递减（元可塑性）**：`Δw = baseLearningRate / (1 + strengthenCount) × nodeFactor`，其中 `nodeFactor = 1 / (1 + activityLevel)`，`activityLevel` 为该节点近期强化次数。长期高度活跃的节点学习率被压低，防止饱和。
- **异突触竞争降权（稳态刹车）**：强化边 `u→v` 时，对同一源节点 `u` 的**其他出边**施加与 `Δw` 成比例的负向修正（局部 O(degree)），保留相对差异、抑制超级枢纽。
- **出边权重预算（软上限）**：保留 `outWeightBudget` 作为安全上限，仅在局部竞争降权后仍超限时按比例压缩。
- **覆盖检测**：新原子与某旧原子向量相似度 > `supersedeThreshold` 且语义相反时，建立 `supersede` 边，旧原子 `validUntil = now`、`suppressed = true`（不删除，保留溯源）。

### 3.2 向量

- 稀疏 TF-IDF：`idf(t) = log((N + 1) / (df(t) + 1)) + 1`，`df` 由现有原子统计（编码时传入）。
- 余弦相似度用于种子检索、覆盖检测、聚类。

## 4. 概念层（增量共现聚类）

- **增量**：写入后只对受影响的原子做局部聚类（图连通分量 + 局部合并），不全量重算。
- **触发**：共现计数 ≥ `clusterCoocThreshold` 且簇大小 ∈ [`clusterMinSize`, `clusterMaxSize`]。
- **容量上限 + 强制分裂**：簇超过 `clusterMaxSize` 时按向量距离强制分裂。
- **分配准备度竞争**：新簇优先分配给 `readiness` 最高的候选（含新建节点，初始 `load = 0`、`readiness = 1`），防止超级概念垄断。
- **概念化速率**：`conceptFormationRate`（0..1）控制阈值触发的松紧——高则更多簇被提升（偏向概括），低则保持精细（偏向区分）。
- **持久化**：聚类结果写入 MiniDb（concept 记录 + concept 边），不每次现算。
- **概念标签（v1 确定性）**：取簇内中心度最高（度最大）的前 3 个原子，用其文本摘要或 TF-IDF Top-3 关键词拼接成标签。`labelSource` 字段预留 `llm`，后置钩子不影响图拓扑。

## 5. 召回（种子 + 稀疏扩散）

```
recall(query):
  1. 两阶段：先 episode(note) 级粗筛，再展开原子
  2. 种子：TF-IDF 向量相似度 Top-M 的原子/概念 + 命中词项 posting 的节点
  3. 稀疏扩散：沿边传播，最多 maxHops 跳，每跳 ×spreadDecay
               每跳 k-WTA 门控：k(hop) = max(1, baseK - hop × kDecay)
               计算预算：累计访问节点数 ≤ computeBudget，超出即截断（Beam Search）
  4. 收敛：得到每个节点激活值
  5. 截断：top-k（默认 8），低于 activationThreshold 剪掉
  6. 过滤：isDeleted / suppressed / validUntil < now（除 includeHistory）
  7. 法典召回闸门（§7）
  8. 冲突：按 §5.1 处理
```

### 5.1 冲突记忆

- 不做系统硬覆盖。命中冲突组时，把冲突的**多个原子一起返回**，各带 `validFrom`、`noteId`、来源、`confidence`，交由模型结合当前上下文判断用哪个。
- 法典硬规则仍可对冲突组做确定性处理（如 pin 某来源、block 某来源）。
- 系统标注"这两条冲突"，但不代替模型决策。

## 6. 衰减、抑制与剪枝

- **两段衰减**：
  - 近期（≤ `powerLawDays`，默认 30 天）：幂律/对数慢衰减，保留长尾。
  - 远期（> `powerLawDays`）：指数衰减（半衰期 `halfLifeMs`）。
- **惰性计算**：衰减在读取时按 `now - lastUsedAt` 计算乘数，不跑全图定时任务。
- **baseWeight 与 pin**：`baseWeight` 表示重要性，独立于被召回次数；`pinned` 不参与衰减。
- **正向反馈**：召回命中后，模型/用户可 `pin`（`baseWeight += 1`），把重要性与被召回次数分开。
- **两个遗忘通道**：
  - **靶向遗忘（信号驱动）**：`supersede` 边 + 显式 `forget`。落败记忆 `validUntil = now` + `suppressed = true`，不删除。
  - **精度衰减（时间驱动）**：两段衰减 + 剪枝。
  - 概念化速率调制原子衰减斜率：`applyDecay` 的 `decayScale = 0.5 + conceptFormationRate`（已实现）。
- **剪枝**：权重 < `pruneThreshold` 的边删除；无连接且过期的原子归档（`isDeleted`）。
- **异步维护**：maintainer（§9）批量做衰减/剪枝/聚类/落盘，避免读时 CPU 峰值；读时仍做必要惰性衰减保证正确性。

## 7. 法典（code）

- **硬规则**：结构化（`pattern` + `action` + `reason`），确定性执行。作用于：写入过滤、召回过滤、冲突处理、保留/遗忘、训练约束。
- **软指引**：自然语言，注入系统提示（`${memory_code}`），模型参照判断；判断结果写审计日志。
- **来源**：内置默认（`code/defaults.ts`）+ 用户文件（`<homeDir>/associative-memory/code.md`，YAML frontmatter，`js-yaml` 解析）。v1 不含模型提议闭环。
- **冲突规则**：默认"用户明确声明的 > 推断的；更新的 > 更旧的"，但只用于**标注与排序**，不硬覆盖（§5.1）。
- **内置默认**至少包含：凭据/密钥类内容不入库；用户明确要求删除的彻底清除。

## 8. 注入与工具

- **reminder**：注册 `associative_memory_signal`，每轮新对话触发，线索取上一条用户消息（复用 `features/reminder` 通道）。
- **注入块**：top-k 渲染成块，包成 system reminder；有 token 预算上限（`injectionMaxTokens`），超预算按激活值截断。
- **去重**：与 gitMemory 的记忆注入共享已渲染集合（按笔记/原子 id）。
- **工具 `MemoryGraph`**：
  - `write`：写入笔记（触发编码 + 训练）。
  - `recall`：显式查询，返回 top-k。
  - `pin`：给某条记忆加重要性/钉住（正向反馈）。
  - `forget`：显式删除/抑制（`isDeleted` / `suppressed`）。
- **工具描述**（prompt text）：引导模型"学到值得记住的东西时写"，不自动、不强制。

## 9. 存储、隔离与并发

- **按项目隔离**：每个项目一个 MiniDb 实例（独立目录）。项目键复用 `projectIdFromCwd` 思路。
- **Event sourcing**：`NoteRecord` 是 Source of Truth；图是派生索引。损坏时重放所有笔记即可重建。
- **写入无锁**：写入路径只做两件事——追加笔记（MiniDb）+ 把变更事件入队（内存队列）。
- **单写者**：一个 maintainer 串行消费变更队列，做 Hebbian 训练、聚类、衰减、剪枝、落盘。多会话写同一项目时，变更在队列里合并，图更新永远单线程。
- **崩溃恢复**：队列未消费完的变更，下次启动时从笔记重放。

## 10. 可观测（stats / explain / audit / list / export / rebuild）

- `stats(scope)`：原子/概念/程序/边/笔记数量与钉住/抑制统计；工具 action `stats`。
- `explain(query)`：输出 **Recall Trace**：线索词 → 种子节点 → 沿哪条边扩散（边权重、衰减比例、跳数、是否被门控截断）、抑制（inhibit）、top-k 命中原因。工具 action `explain`。
- 审计日志：JSONL 追加（`<storeDir>/associative-memory/audit.jsonl`），条目 `{ at, kind, detail }`；覆盖写入过滤、召回过滤、pin/forget、supersede、embeddings 决策、replay、rebuild、提议/批准、标签。`audit(limit)` 读取（新的在前），工具 action `audit`，`export` 内含。

## 11. 系统提示集成

- `systemPromptVars` 增加 `${memory_code}`（软指引正文），`system.md` 增加对应段落。
- flag 关闭时渲染为 `''`。
- 这是 prompt text 变更（behavior），需同步 i18n 与 prompt 拥有权检查（见 `CONVENTIONS.md`）。

## 12. 参数表

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `maxAtomChars` | 400 | 原子切分字数上限 |
| `contextWindowMs` | 24h | Hebbian 上下文窗口 |
| `baseLearningRate` | 1.0 | 学习率基数（随 strengthenCount 与 nodeFactor 递减） |
| `outWeightBudget` | 50 | 节点出边权重软上限 |
| `maxEdgeWeight` | 20 | 单边上权上限 |
| `spreadHops` | 3 | 扩散最大跳数 |
| `spreadDecay` | 0.5 | 每跳衰减 |
| `baseK` / `kDecay` | 5 / 1 | k-WTA：`k(hop)=max(1, baseK - hop×kDecay)` |
| `computeBudget` | 500 | 扩散累计访问节点上限（Beam） |
| `seedTopM` | 50 | 向量种子数 |
| `topK` | 8 | 召回数量 |
| `activationThreshold` | 0.1 | 激活阈值 |
| `vectorThreshold` | 0.3 | 向量相似门槛 |
| `clusterCoocThreshold` | 3 | 共现阈值 |
| `clusterMinSize` / `clusterMaxSize` | 3 / 20 | 簇容量（超限强制分裂） |
| `loadRef` | 10 | 分配准备度参考负载 |
| `conceptFormationRate` | 0.5 | 概念化速率（0..1） |
| `powerLawDays` | 30 | 衰减前段（幂律）天数 |
| `halfLifeMs` | 30d | 衰减后段半衰期 |
| `pruneThreshold` | 0.05 | 剪枝阈值 |
| `injectionMaxTokens` | 600 | 注入块 token 预算 |
| `supersedeThreshold` | 0.9 | 覆盖检测相似度门槛 |

## 13. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 一等单元存储（替换 markdown 记忆） | 丢 git 版本化、引入第二真相源 |
| 扩展 gitMemory 索引 | 缓存按 headSha 失效，粒度错；领域耦合 |
| 全局聚类（每次全量重算） | 写放大、延迟高；改增量 |
| 纯指数衰减 | 早期衰减过快；改两段 |
| 概念标签取高频词拼接 | 语义含糊；改中心度原子摘要（LLM 后置） |
| 系统硬覆盖冲突记忆 | 旧记忆可能代表旧系统逻辑；改双时态区间关闭 + 带溯源交给模型 |
| 读时完全惰性衰减 | 冷启动 CPU 峰值；改异步维护 + 惰性兜底 |
| 项目内全局写锁 | 多请求写慢；改追加 + 单写者队列 |
| E-to-I 学习抑制边 | 需要"哪个正确"的反馈信号，v1 没有；k-WTA 已是竞争机制 |
| 全局归一化（独立周期任务） | 不如局部异突触降权及时；改局部 |
| hnswlib / faiss | 原生依赖过重；v1 内存暴力余弦，规模中等够用 |
| 硬删除记忆 | 丢溯源；改双时态区间 + 软删除标记 |

## 14. 核心接口（伪代码）

```ts
// ---- 事件（写入路径追加，maintainer 消费）----
type MemoryEvent =
  | { kind: 'note'; noteId: string; scopeKey: string; text: string; at: number }
  | { kind: 'supersede'; fromId: string; toId: string; at: number }
  | { kind: 'forget'; id: string; at: number }
  | { kind: 'pin'; id: string; at: number };

// ---- 写入 ----
interface WriteResult {
  noteId: string;
  atomIds: string[];
  blockedByCode: boolean;
}

// ---- 召回 ----
interface RecallQuery {
  cue: string;
  limit?: number;
  maxTokens?: number;
  includeHistory?: boolean;
}

interface RecallItem {
  id: string;
  kind: 'atom' | 'concept';
  text: string;
  score: number;
  noteId: string;
  conceptId?: string;
  confidence: number;
  validFrom: number;
  validUntil?: number;
  conflictGroup?: string;
}

interface RecallTraceNode {
  id: string;
  kind: 'seed' | 'spread';
  score: number;
  viaEdge?: { from: string; weight: number; decayed: number };
  truncated?: boolean;
}

interface RecallResult {
  items: RecallItem[];
  trace: RecallTraceNode[];
}

// ---- 服务 ----
interface IAssociativeMemoryService {
  writeNote(text: string): Promise<WriteResult>;
  recall(query: RecallQuery): Promise<RecallResult>;
  pin(id: string): Promise<void>;
  forget(id: string): Promise<void>;
  stats(): Promise<AssociativeMemoryStats>;
  explain(query: RecallQuery): Promise<RecallTraceNode[]>;
}

// ---- 纯函数 ----
declare function splitNote(text: string, maxChars: number): string[];
declare function encodeAtoms(note: NoteRecord, df: ReadonlyMap<string, number>, clock: Clock): Atom[];
declare function hebbianConnect(newAtoms: Atom[], context: Atom[], edges: Edge[], params: Params): Edge[];
declare function applyDecay(edges: Edge[], now: number, params: Params): Edge[];
declare function clusterIncremental(atoms: Atom[], coocs: Cooccurrence[], concepts: Concept[], params: Params): { concepts: Concept[]; edges: Edge[] };
declare function activate(query: RecallQuery, atoms: Atom[], concepts: Concept[], edges: Edge[], params: Params): RecallResult;
declare function renderRecall(result: RecallResult, maxTokens: number): string;
```

## 15. 测试策略

- **纯函数单测**：`encode` / `train`（学习率递减、异突触降权、出边预算）/ `decay`（两段、惰性）/ `cluster`（容量上限、强制分裂、分配准备度）/ `activate`（跳数、阻尼、门控、预算、冲突、双时态过滤）/ `render` / `code`（硬规则）。
- **时间依赖**：注入时钟（`Clock`），固定参数，保证可复现。
- **集成**：写笔记 → 召回命中；违反硬规则的笔记不入库；冲突组带溯源返回；`supersede` 后旧节点区间关闭且被抑制。
- **Reminder**：注入块格式与去重。
- **Rebuild**：删除图索引 → 从笔记重放重建 → 结果一致。
- **并发**：多写路径并发追加，maintainer 单线程消费，图状态一致。

## 16. v1 / v1.5 / v2 划分

**v1（本 spec 范围，已全部实现）**：§1–§15 全部，含异突触降权、元可塑性、分配准备度、k-WTA 跳数耦合、Beam 预算、双时态、抑制态、Event Sourcing + 单写者、Recall Trace、list/两阶段 episode 召回、project/global/all 三维 scope、导出。

第三轮补充（原 v1.5/v2 项，均已实现）：
- **概念化-衰减耦合**：`conceptFormationRate` 调制衰减斜率（`applyDecay` 的 `decayScale = 0.5 + rate`）。
- **E-to-I 学习抑制边**：supersede 时建立 `inhibits` 边；召回时按 `inhibitionFactor` 压制竞争节点。
- **RPE 离线重放**：supersede 记为 `replayPriority`；`replay` action 按优先级采样并局部再巩固。
- **程序/技能层**：重复出现的多步笔记蒸馏为 `procedure` 节点（`procedureMinSteps`/`procedureThreshold`），参与召回与列表。
- **模型提议法典闭环**：`propose`/`approve` action，批准写入 `code.md` 的 frontmatter。
- **LLM 概念标签**：模型驱动（`label` action），`labelSource = 'llm'`。
- **外部 embeddings**：env 配置（`KIMI_CODE_ASSOCIATIVE_MEMORY_EMBEDDINGS_*`），opt-in；法典可用 `block_embed` 禁止外发。

**第五轮收尾（已全部实现）**：
- **显式再巩固通路**：`reconsolidate(targetId|undefined, text)`——编码新证据、连到目标邻域、矛盾则覆盖（专用阈值 0.5，仅覆盖目标）；服务记录 `lastRecallIds`，无 id 时针对最近召回项。工具 action `reconsolidate`。
- **完整审计界面**：`audit.ts` 追加式 JSONL（`<storeDir>/associative-memory/audit.jsonl`），覆盖写入过滤/召回过滤/pin/forget/supersede/embeddings/replay/rebuild/提议/批准/标签；`audit(limit)` + `audit` action；`export` 内含审计。
- **离线评测基准**：`src/features/associativeMemory/eval.ts`（`evaluateRecall` → hit@1/hit@5/MRR）+ `test/features/associativeMemory/eval.test.ts` + `eval.bench.ts`（真实 service + 合成语料，`bun test ./test/features/associativeMemory/eval.bench.ts` 运行；`.bench.ts` 不被默认套件收集）。

**接线缺口修复**：`stats`/`explain`/`rebuild` 已作为工具 action 暴露；`resolveConflict` 经 `orderConflictGroups` 接入召回路径。

**待办（未实现）**：无。

**v1.5**：无（原 v1.5/v2 项均已并入 v1）。

**v2**：无（原 v2 项已并入 v1）。

**提交审批时的决策项（见 ExitSpecMode 选项）：**

1. **概念标签**：v1 确定性（`label_source = 'deterministic_v1'`）/ v1 即启用 LLM 提炼。
2. **maintainer 异步维护**：v1 纳入（写入追加 + 单写者 worker）/ v1 后置（写入路径内联同步更新图，先依赖惰性衰减；并发扩展性留到 v1.5）。

## 17. 风险

- **复杂度**：参数多、机制多。缓解：默认参数给全，Recall Trace 辅助定位；v1 建好后先量再扩展。
- **概念层质量**：聚类概念可能语义含糊。缓解：标签可读、分配准备度防垄断、v1.5 LLM 提炼。
- **隐私**：默认本地向量、外部 opt-in；法典可禁止外发。
- **效果评估**：无离线评测基准（v1.5）。缓解：Recall Trace + 人工抽查。
