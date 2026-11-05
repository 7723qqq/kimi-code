# Progress — 自训练关联记忆（associative memory）

## 当前状态

spec 已审批（完整 v1：确定性标签 + maintainer）。**T1–T13 全部完成**，实现与测试落地。

| 项 | 状态 |
| --- | --- |
| requirements / design / tasks | 已写，已评审 |
| T1–T13 | 完成 |
| 门禁 | typecheck、check:no-comments、check:boundaries、check:deep-imports、check:no-hardcoded-prose、check:locale-keys、check:locale-placeholders、check:t-coverage、check:prompt-ownership、oxlint（0 error）、check:lint 全链 exit 0 |
| 测试 | `test/features/associativeMemory/` 62 pass / 0 fail（12 文件） |

## 已确认的决策

| 议题 | 选择 |
| --- | --- |
| 形态 | 独立子系统，与 app/memory 并存；按项目隔离 |
| 核心机制 | 原子 + 概念 + 带权边；写入即训练（Hebbian）；两段衰减 |
| 法典 | 硬规则（确定性）+ 软指引（系统提示，模型参照）；内置默认 + 用户文件 |
| 向量 | v1 本地稀疏 TF-IDF；外部 embeddings 后置 |
| 概念标签 | v1 确定性（中心度原子摘要）；`label_source` 预留 llm |
| 存储 | MiniDb；笔记是 Source of Truth，图是派生索引，可重放重建 |
| 并发 | 写入追加无锁 + 单写者串行队列（promise chain） |
| 冲突 | 双时态区间关闭 + 带溯源交给模型，不硬覆盖 |

## 实现清单

源码（`packages/agent-core-v2/src/features/associativeMemory/`）：
`flag.ts`、`types.ts`、`params.ts`、`vector.ts`、`encode.ts`、`train.ts`、`decay.ts`、`cluster.ts`、`activate.ts`、`render.ts`、`code.ts`、`code/defaults.ts`、`code/load.ts`、`store.ts`、`service.ts`、`tools/memoryGraphTool.ts`、`tools/memoryGraph.md`。

集成点：
- `src/index.ts`：导出 flag/types/params/service/code/defaults，side-effect import 工具。
- `src/agent/profile/profileService.ts`：注入 `IAssociativeMemoryService`，把 `memoryCode` 放入提示词上下文。
- `src/app/agentProfileCatalog/agentProfileCatalog.ts`：`AgentProfileContext.memoryCode`。
- `src/app/agentProfileCatalog/profile-shared.ts`：`memory_code` + `memory_code_section`。
- `src/app/agentProfileCatalog/system.md`：`${memory_code_section}`。
- `packages/i18n/src/locales/{en,zh}.ts`：`toolsV2.memoryGraph.*`。

## 实施记录（关键取舍）

- `store.ts` 的 MiniDb 缓存按 `storeDir + scopeKey` 键控，且缓存 promise：并发写同一项目不会重复 open 同一目录（MiniDb 独占写锁）。
- `activate` 的 `includeHistory` 同时绕过 `suppressed` 与过期区间；`isDeleted`（显式 forget）始终隐藏。
- `code.ts` 复用 `#/_base/text/frontmatter` 的 `parseFrontmatter`，不重复实现 YAML 解析。
- `index.ts` 的 `memory_code` 走 composed-section 模式（`memory_code_section`），flag 关闭时整段为空。

## 未提交

工作区另有两处**预先存在**的未提交改动（`src/remote/client/launchers.ts`、`remoteSession.ts`），非本特性所改，未触碰。

## 完整测试结果（2026-11-05）

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 本特性 | `bun test --isolate test/features/associativeMemory/ test/app/agentProfileCatalog/` | 179 pass / 0 fail |
| 引擎全包 | `cd packages/agent-core-v2 && bun run test` | 8488 pass / 69 fail；重跑后 **全部为竞争**，"the package passes in isolation" |
| i18n | `cd packages/i18n && bun run test` | 43 pass / 0 fail |
| node-sdk | `bun run test` | 321 pass / 0 fail |
| kap-server | `bun run test` | 1316 pass / 0 fail |
| 门禁 | `bun run check:lint` | exit 0 |
| 类型 | `cd packages/agent-core-v2 && bun run typecheck` | 仅 3 个错误，全部是 `test/remote/fs.test.ts` 的**合并冲突标记**（非本改动） |
| 构建 | `cd packages/agent-core-v2 && bun run build` | 同上，仅冲突标记报错；冲突出现前构建通过 |

### 预先存在的失败（非本改动）

- `test/session/agentLifecycle/agentLifecycle.test.ts`：隔离跑 55 fail。用 `git stash` 去掉本改动的 7 个跟踪文件后复跑，仍是 55 fail → 与本改动无关。
- `test/features/codeRuntime/codeRuntime.test.ts`：全包下内存压力抖动（memory-limit → worker-exit），隔离跑 15 pass。
- `apps/kimi-code` 的 3 个 typecheck 错误（`EnvironmentSlotState` 缺 `type`）：定义在 `apps/kimi-code/src/tui/types.ts`，本改动未触及。

### 工作区状态提醒

工作区索引存在**未解决的合并冲突条目**（`git ls-files -u` 列出多个文件，含 `test/remote/fs.test.ts`，stages 1/2/3），且 `test/remote/fs.test.ts` 文件内残留 `<<<<<<< / >>>>>>>` 标记。没有 MERGE_HEAD/REBASE_HEAD（被中断的合并遗留）。这会破坏全局 typecheck 和 build，需要使用者自行解决，本特性未触碰这些文件。

## 推进开发（第二轮）

- 补上设计里漏的三处机制：reminder 渲染去重（`rendered` 集合）、笔记内共存原子互相连边（context 含 newAtoms）、概念 `pinned`。
- 补上两个没接线的参数：`seedTopM`（种子截断）、`conceptFormationRate`（调制共现阈值）。
- 实现概念层的"按准备度合并"（readiness 竞争分配），并加测试。
- 新增端到端 reminder 注入测试（最后一条未验证项）与 `${memory_code}` 提示词测试。
- 清理未使用导出（`systemClock`/`SystemClock`/`Clock`）。
- 修复本改动引起的唯一真实失败：`systemPromptTemplate.test.ts`（把 `${memory_code_section}` 移到 `${model_adaptation_section}` 之前）。

## 审查（code-review 技能，三遍）

### MAJOR（已修）

- **衰减/剪枝从未接线**：`applyDecay`/`pruneEdges` 只在自己的单测里被调用，service 从不执行——"写入即训练 + 衰减"的主干缺了一半，图会无界增长。已在 `trainNote` 末尾接入 `maintain()`（惰性两段衰减 + 剪枝 + 持久化），并加 service 级测试证明 400 天后旧边被剪掉。
- **过期边永不衰减**：`applyDecay` 对 `validUntil !== undefined` 的边直接返回，`pruneEdges` 又无条件保留它们 → 过期边永久堆积。改为所有边都衰减、统一按阈值剪枝；过期原子记录仍保留（溯源靠原子的 `validUntil`/`suppressed`）。

### MINOR（已修）

- 种子截断误伤词项命中：`seedTopM` 现在只截向量种子，词项命中的种子全部保留。
- `mergeConcept` 对不在 `atomById` 里的原子没有防御 → 加 `filter`。
- `splitNote` 在 `maxChars <= 0` 时会死循环 → 加守卫。
- 工具错误分支复用成功文案（缺 id/query 时返回 `isError: true` 却输出"Pinned."）→ 新增 `idRequired`/`queryRequired` 键。
- `stats`/`rebuild`/`pin`/`forget` 没有 flag 守卫（flag 关时也会建库）→ 加守卫。
- 被钉住的原子会被自动 supersede → 跳过 pinned。
- `appendNote` 与 `putNote` 重复 → 合并。
- `noteRecordId` 用 `Math.random()` → 改用仓库的 `ulid()`。
- render 的 token 预算用字符启发（对中文低估约 4 倍）→ 改用仓库 `estimateTokens`。
- `.sort()` → `.toSorted()`（14 处）；`store.load()` 去掉多余的 `async`。

### 第三轮：补设计缺口

- **`list` 工具 action**（R9 要求"列出记忆内容"）：按最近激活排序，支持 `kind`/`limit`。
- **两阶段 episode 粗筛召回**（design §5）：先按笔记聚合分数选 top-N 笔记（`episodeTopN`），再展开它们的原子。
- **全局/跨项目 scope**（v1.5 项）：`project` / `global` / `all` 三维；写入默认 project，读取默认 all；`pin`/`forget`/`stats`/`list`/`export` 都按 scope 走。
- **导出**（R9/数据治理）：`export` action 把原子/概念/边/笔记写到 cwd 的 `memory-export.json`。
- 参数：新增 `episodeTopN`、`listLimit`。

## 第四轮：补完 v1.5/v2 全部项目

1. **概念化-衰减耦合**：`applyDecay` 增加 `decayScale`，service 用 `0.5 + conceptFormationRate` 调制（概念化越快，细节衰减越快）。
2. **E-to-I 学习抑制边**：`hebbianConnect` 在 supersede 时同时建 `inhibits` 边；`activate` 按 `inhibitionFactor` 压制竞争节点，并记入 Recall Trace。
3. **RPE 离线重放**：supersede 的旧原子 `replayPriority += 1`；`replay(limit)` 按优先级采样，对它们的邻域做一次局部 Hebbian 再巩固，随后递减优先级。
4. **程序/技能层**：`procedure.ts` 把重复出现（`procedureThreshold`）的多步笔记（`procedureMinSteps`）蒸馏成 `Procedure`；store 新增 `procedure:` 前缀；`activate` 把 procedure 作为节点参与召回；list/stats/export 都带上。
5. **模型提议法典闭环**：`code/proposals.ts` 把提议追加到 `proposals.md`；`approveProposal` 解析 JSON、写回 `code.md` 的 frontmatter、移除该行；`code/rules.ts` 共享 `toHardRule`。
6. **LLM 概念标签**：`labelConcept(id, label)` + `label` action，`labelSource = 'llm'`（模型驱动，非后台调用）。
7. **外部 embeddings**：`embeddings.ts`（env 解析 + OpenAI 兼容客户端）；原子/概念存 `denseVector`；写入时嵌入、召回时嵌入线索；`cosineDense`/`averageDense`；法典新增 `block_embed` 动作做隐私门禁；失败时回退稀疏匹配。

## 第五轮收尾（可交付）

1. **审计日志**：`audit.ts`（JSONL 追加/读取）；service 全部关键路径写审计（write_blocked/write_allowed/recall_filtered/pin/forget/supersede/reconsolidate/embeddings_blocked/replay/rebuild/code_proposed/code_approved/label）；`audit(limit)` + `audit` action；`export` 内含审计。
2. **显式再巩固通路**：`reconsolidate(targetId|undefined, text)`——编码新证据、连到目标邻域、与目标相似度 > 0.5（专用阈值，仅目标）则覆盖；`lastRecallIds` 支持无 id；工具 action `reconsolidate`。
3. **离线评测基准**：`eval.ts`（`evaluateRecall` → hit@1/hit@5/MRR）+ `eval.test.ts` + `eval.bench.ts`（真实 service + 合成语料，lexical 1.0 / synonym 0.167 的稀疏基线，后者衡量 embeddings 价值）。
4. **接线缺口修复**：`stats`/`explain`/`rebuild` 成为工具 action；`resolveConflict` 经 `orderConflictGroups` 接入 `recall`。
5. **文档对齐**：requirements/design/tasks/progress 与实现一致；design §16 "待办"为空。

### 基准结果（2026-11-05，稀疏向量）

```
lexical  overall  queries: 6  hit@1: 1.000  hit@5: 1.000  mrr: 1.000
synonym  overall  queries: 6  hit@1: 0.167  hit@5: 0.167  mrr: 0.167
```

### 最终验证（2026-11-05）

| 项 | 结果 |
| --- | --- |
| `bun test --isolate test/features/associativeMemory/ test/app/agentProfileCatalog/` | 217 pass / 0 fail（22 文件） |
| `bun test ./test/features/associativeMemory/eval.bench.ts` | 通过，打印指标 |
| `cd packages/agent-core-v2 && bun run typecheck` | 0 error |
| `bun run check:lint`（全链） | exit 0 |
| `bun run check:locale-keys` / `check:locale-placeholders` / `check:t-coverage` / `check:prompt-ownership` | 全绿 |
| `cd packages/agent-core-v2 && bun run build` | 通过 |
| 改动文件 oxlint | 0 error |

### 实施中修正的一处边界

`render.ts` 原导入 `#human/llm/tokens` 的 `estimateTokens`，被 `check-import-boundaries` 拦下（该实现只允许 llm-adapter / agent-loop / session-lifecycle 及一组词汇模块导入）。改为在 `render.ts` 内做本地估算（`ceil(ascii/4) + nonAscii`，与仓库公式一致），不再跨边界导入。

## 已知限制（未改，记录）
- 概念标签默认确定性（中心度原子摘要）；LLM 提炼由模型通过 `label` action 驱动（非后台自动调用）。
- supersede 的"语义相反"无法纯函数判定，用高相似度作代理；被钉住的原子不会被自动 supersede。
- `stores` 缓存在进程生命周期内不关闭（CLI 短进程可接受；长驻服务需加淘汰）。
- 用户法典的正则由用户自己写，存在 ReDoS 自伤面（不影响他人）。
- 导出固定写到 cwd 的 `memory-export.json`（未做轮转/大小上限）。
