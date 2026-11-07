
## 计划外追加（继续测试与推进）

| 追加项 | 结果 |
| --- | --- |
| 内容 vs 关联的寿命 | 内容 5 年仍在、关联 3 年断掉；已钉为两条断言 |
| 整固收敛性 | 同一簇 6 轮整固后概念数**收敛不再增长**（实测出现过 2 个不相交子簇，非重复） |
| 概念碎片化 | 发现「概念与概念」无合并路径 → 新增 `mergeOverlapping`（按共享成员合并，保留先出现者 id） |
| 概念排名结论修正 | 实测概念种子分最高（1.027 vs 0.449），但扩散给原子 +0.514 后反超 → 按设计 §3 兜底，定位为**压缩节点**并写入 `memoryGraph.md`；断言从「前 3」改为「前 5」 |
| 概念窄 cue 抢首 | 中途把 `mergeConcept` 词项上限提到 12 导致概念抢窄 cue 首位，已撤回；改用**成员覆盖数**判据（命中 ≥2 个成员才加分） |
| 扩散是否稀释精度 | 两种构造均未测到稀释（强匹配原子在不同跳数下稳居首位；另一次并列是环形成员真的命中全部 3 个词）；已钉 4 条断言 |
| 跨 scope 淘汰公平性（`scopeIsolation.test.ts`） | 发现真实缺陷：`activate.ts` 的 episode 窗口 `topNotes` 是**跨 store 全局取 `episodeTopN`(=3)**，于是 `scope:'all'` 不是并集而是「全场前 3 个 note」。project 有 >=3 条时 global 被整条丢弃（实测 global 0.653 排第 4），`recall('all')` 与 `signalBlock` 注入同时中招。修复：episode 窗口按 `atom.scopeKey` 分组，每个 store 各自保留 3 个 note 再取并集；单 scope 只有一个分组，行为不变。反向验证：还原成全局前 3，`scopeIsolation` 立刻 2 条红（`all` 召回 + `signalBlock`），恢复后 5 条全绿 |
| 写入扩展性（边裁剪） | 实测写入随库线性变慢：0→50 **4.41ms/write**、200→400 9.23、400→800 **21.55**（`MAX_ATOMS=4000` 外推满库约 100ms）。用 store 方法级计时定位：`hebbianConnect` 单次 13.86ms，其中为 1 个新原子生成 ~800 条候选边、跑 O(k²) 侧抑制、再裁到 `MAX_OUT_DEGREE=12`，且把 788 条**从未落盘**的候选边当“待删边”发给 store（每写 889 次 `deleteEdge` 空转）。`updateCooccurrence` 另有 6.34ms：为查 24 个 key 而重建 1.8 万条 cooccurrence 的 Map |
| 写入扩展性修复 | `train.ts` 改为：侧抑制用后缀和一次结算（`max(0, base - HETERO*Σ后序delta)`，与逐次 clamp 代数等价）、裁剪只在内存完成、`deleted` 只上报确实在 store 里的边；`service.ts` 的 `updateCooccurrence` 改用 `getCooccurrence` 索引，不再整表建 Map。结果：400→800 **21.55 → 9.35ms/write**（-57%），`hebbianConnect` 13.86→3.63ms，每写 `deleteEdge` 889→2；atoms/edges 计数与改前逐点相同（449/953/1945/3945/7945），证明行为等价。新增 2 条断言钉住契约（`deleted` 只含已存边；两次后续连接各压一次） |
| 概念层不可达 | 密集语料写入 120 条，概念数恒为 0；测 cooccurrence 分布发现**所有 pair 的 count 恒为 1**（max=1）。根因：`trainNote` 的共现窗口是“最近激活的 24 个原子”，而写入从不刷新旧原子 `lastActivatedAt`，每对原子只可能在“后写的那条”配对一次，永远到不了阈值 3。`conceptFormation.test.ts` 之所以绿，是它用 `recall({reinforce:true})` 反复召回；生产里只有 `MemoryGraph` 的 `recall`/`explain` 这么调，注入路径 `signalBlock` 既不强化也不记共现 —— 概念层在真实使用中恒为空 |
| 概念层可达性修复 | 按「观测 / 强化分离」落地：共现是“这些记忆同处一个上下文”的观测，任何激活处都记；边权增强才是刻意使用的强化，仍只在 `reinforce` 时发生。`signalBlock` 注入后记录共现（≤ C(8,2) 次 put）。同时修 `recordActivationCooccurrence` 把不属于该 store 的原子 id 也写进去（跨 scope 时的幽灵 pair）。新增 2 条断言：跨会话注入 4 轮后概念数 >0；单次注入只增共现计数、不改任何既有边权、不产生 hebbian 边。反向验证：摘掉 `signalBlock` 的共现调用，两条立刻变红 |
| 注入观测的代价与守卫 | 注入时记录共现后 `signalBlock` 从 10.18 → 12.78ms/次（400 原子），其中大部分是每轮都跑一次 O(n) 的 `clusterIncremental`。把聚类阈值提成 `cluster.ts` 的 `coocClusterThreshold()` 供两处共用，并且只有当某对共现**首次跨过阈值**时才重建聚类 → 11.82ms/次（+1.6ms）。跨会话概念形成的断言仍成立 |
| 共现表无界且 100% 噪声 | 400 原子实测 `coocs=8924`，count 直方图 `[[1,8924]]` —— 全部低于聚类阈值 3，永远不参与聚类；增长约 22 条/原子（`MAX_ATOMS=4000` 时约 9 万条）。边有 `pruneEdges`、原子/笔记有 `enforceBudgets`，只有共现没有任何修剪。修法：`decay.ts` 新增 `pruneCooccurrences`（count 未达阈值且 `now-lastAt > halfLifeMs` 视为噪声），接在 `maintain`；阈值由 `cluster.ts` 的 `coocClusterThreshold()` 统一提供。反向验证：摘掉修剪块 `maintenance` 立刻 1 条红。新增 3 条断言（规则单测 + 维护后残留必须是大半衰减 + 跨阈值 pair 必须留下） |
| `forget` 不解绑关联、`stats` 与 `list` 读数不一致 | 探针实测：忘记一个原子后 `stats.edges` 不变、仍有 1 条边与 1 条共现引用它；且 `list.atoms`=1 而 `stats.atoms`=2。根因：`forget` 只把原子标 `isDeleted+suppressed`，而 `enforceBudgets` 的 `live` 排除 suppressed，于是它永远不会被 `retireAtoms` 清理，边永久占 `outWeightBudget`；`stats` 又没过滤 `isDeleted`。修法：抽出 `detachAtomLinks()`（原 `retireAtoms`/`removeAtoms` 是两份重复循环，后者还是死代码，已删），`forget` 原子=清链接+留墓碑，`forget` 概念/流程=直接删除（派生件可重建，否则 `list` 仍能列出被忘掉的概念），`stats.atoms` 过滤 `isDeleted` 与 `list` 对齐。新增 2 条断言，改写 1 条旧断言（原来断言 `suppressed==1`，现在是「从所有读路径消失」） |
| 记忆图不可复现 | 同一用例连跑三次：1 fail / 2 pass。根因不是逻辑而是并列打破用 ULID（时间前缀+随机）：出边裁剪 `train.ts`、共现窗口取前 24、`consolidate` 的 pool、预算淘汰同分者、聚类组件顺序与 `labelFromAtoms`，都按随机 id 排序，于是同一语料每次挑中的候选不同、自动标签也会变。修法：新增 `terms.ts` 的 `compareByText`（原子 text 升序，text 相同才退回 id），四处热点 + 聚类两处全部改用它。连跑 8 次由「1 fail/2 pass」变为稳定同一结果 |
| 概念抢窄 cue 首位（去随机后才暴露的确定性问题） | 固定顺序后 `canary slice` 这类窄 cue 由概念占首位（concept 1.322 vs atom 0.992）。定位到 `activate.ts` 的公式不对称：术语分量对原子用 tf 加权和 `weight`，对概念却用命中个数 `matched`（最多 5），等于概念仅因词表更大就白拿 2.5 倍。改为两者统一用 `weight`：窄 cue 回到原子首位（0.725 vs 0.665），概念仍在第二位；`conceptRanking`/`conceptFormation`/`eval.gate` 全绿 |
| 写路径的阶段成本剖面（n=1200） | 逐函数计时：`hebbianConnect` **2.60ms**、`clusterIncremental` 1.16、`updateCooccurrence` 1.05、`distillProcedures` 0.91、`recordAudit` 0.82、`computeDf` 0.41、`encodeAtoms` 0.49（合计 ≈ 单写 9.3ms）。三档规模实测写入/召回/注入：300 原子 4.16/2.74/3.23、600 原子 6.38/3.52/4.29、1200 原子 9.30/6.76/7.42 —— 全部随 n 近似线性，瓶颈都是「每次操作扫全部原子」 |
| cue 的停用词被当成内容词（精度缺陷） | 实测：只含停用词的 cue 会召回**全部**记忆——`"the"` → 2/2 条、`"the of and"` → 2/2 条；而零重叠的 `"zzz qqq"` → 0 条。根因：`activate.ts` 的 `cueTerms = tokenize(query.cue)` 没有过 `STOP_TERMS`，而节点 terms 里保留着 `the` 等停用词，于是任意含 stop word 的自然语言 cue 都会以 `overlap=1/cueSet.size` 命中所有含 `the` 的笔记。真实用户输入几乎全含停用词，所以这是常态路径。修法：cue 词项先过滤 `STOP_TERMS`；过完后为空则 seed 为 0（返回空，而不是返回全部）。验证：三档词面门禁数字完全不变（1.000 / 0.667·1.000·0.806 / 0.167·1.000·0.583），305→310 全绿；新增断言「纯停用词 cue 必须返回空、含内容词仍能召回」，反向验证（撤掉过滤）该条立刻红 |\n| `eval.bench.ts` 从未进入任何门禁 | `bun test` 只收 `.test/.spec` 后缀，`eval.bench.ts` 不在 49 个测试文件内；`packages/agent-core-v2` 的 `test:bench` 脚本只跑 `test/agent/contextProjector/contextProjector.bench.ts`。而这个文件是唯一度量**同义改写**（paraphrase cue）的地方，且其断言只有 `hitAt5 > 0`。实测（`bun test ./test/features/associativeMemory/eval.bench.ts`）：easy 档 synonym hit@1/hit@5/MRR = 0.167/0.167/0.167，clustered = 0.167/0.333/0.222，per-topic-duplicates = 0.167/0.167/0.167 —— 与词面档（1.000）形成断层，但从未被门禁看见 |\n| 结构生成移出写路径（CLS 重放） | 概念聚类从「每次共现跨阈值就重算」改为只在维护窗口（每 8 写 / 6h）跑，`pruneAndEnforceBudgets` 调用 `refreshConcepts`。写入 1200 原子 **9.30 → 7.47ms**（-20%）。流程提炼 `distillProcedures` 曾一并移出，但 `procedureFormation`/`durability` 4 条测试立刻红（小语料永远到不了 8 写边界）——它对应可见的产品行为，已放回写路径，只保留概念延后 |
| 被反复需要的记忆会被淘汰（可靠性缺陷） | 实测（预算 2，12 轮 ×2 天，每轮 `signalBlock` 同一个 cue 再写一条无关噪声）：第 1 轮注入成功，**第 12 轮注入已为空**，最终 `survived=false`，召回返回空。根因：注入不计入 recency，`accessibility` 里的时间因子只认 `lastActivatedAt`，而它只在写入与显式 `reinforce` 时更新，所以「用户反复问到的记忆」竞争不过「刚写入的噪声」。修法：`signalBlock` 注入后调 `touchInjected` 刷新被注入原子的 `lastActivatedAt`（**只刷时间，不动边权/strength**，与「刻意使用才强化」的划分一致；`rendered` 每会话只注入一次，因此不会形成自我强化）。修后同样的 12 轮：第 12 轮仍注入、最终仍可召回。新增断言并反向验证（撤掉该调用立刻红） |
| 合并会静默丢弃正文 | `write_noop` 审计原来只记 `{scope, noteId}`，被丢弃的第二条正文不可恢复。改为附加 `discarded`（截断 400 字符）。新增断言：语序反转的两条合并后，审计里能读到被丢弃的那句原文。同时在 `memoryGraph.md` 写明「词项按集合比较，仅换语序视为同一条」这一用户可见契约 |
| `reconcile` 语义此前只有「revision 自增」的断言 | 用真实临时目录实测：磁盘新增 `beta.md` 后 `reconcile()` → `list()` 变成 `[alpha, beta]` 且 `search('rollout')` 命中 beta；删除 `alpha.md` 后 `reconcile()` → `list()` 只剩 beta 且 `get('global/alpha.md')` 为 undefined。即实现是对的、**测试太弱**。已在 `memoryStore.test.ts` 补「索引随磁盘增删对齐」的断言 |
| `limit` 被多样性上限静默截到 3 | 实测：8 条同样相关的笔记、`limit: 8` → **只返回 3 条 / 3 个不同 note**（`episodeTopN = 3`）。所以门禁里的 `hit@5` 结构上就是 `hit@3`。未改行为（改它会放大注入条数，属产品决策），只在 `memoryGraph.md` 写明「每个 scope 最多 3 条不同 note，调大 limit 不会更多」 |
| 工具描述与实现不符（逐条核对后修正） | 把 `memoryGraph.md` 每句对到代码/实测，查出 **4 处假的**：(1)「held back for several turns」——实际 `renderedLines` 按 **sessionId** 记，整个会话内不再出现（`MAX_TRACKED_LINES=1024`），没有轮次窗口；(2)「`recall` covers both, markdown memories tagged `[memory:<path>]`」——**全仓不存在任何 `[memory:` 生产者**，`handleRecall` 只渲染图内条目，`src/agent/injection/` 只有 `renderedLines.ts`；(3) `forget`「hidden from recall but kept for audit」——现在同时删掉它的边/共现/包含它的概念与流程；(4) `list`「newest first」——实际按 `lastActivatedAt` 倒序。另补：`stats` 已遗忘的不计入、`limit` 每 scope 最多 3 条不同 note、`write` 按词集合比较（仅换语序视为同一条） |
| `replay` 在生产路径上不可达（代码遗漏，已修） | 两条独立原因：`replay` 只收 `replayPriority > 0`，该字段只在 `trainNote` 的 supersede 分支 +1；而写路径 supersede 需要 `cosine > 0.9`，实测 17 词仅差 1 词时余弦 **0.8934**（差 0.0066 够不到），5–15 词的真实笔记永远到不了。`reconsolidate` 路径阈值是 **0.5**，能触发 supersede（实测 `superseded: true`、旧原子 `suppressed=true`），但**忘了写 `replayPriority`** → `replay()` 仍返回 0。修法：给 `reconsolidate` 的 supersede 分支补 `replayPriority: old.replayPriority + 1`；修后同一实验 `replayed: 1`。`memoryGraph.md` 的 `replay` 一节按实测重写（含「不会解除抑制」「只读 project scope」），补 2 条断言 |
| 用户文档同源错误 | `docs/en/reference/tools.md` 与 `docs/zh/reference/tools.md` 的 `MemoryGraph` 条目同样写着 `forget`「kept for audit / 保留以备审计」，已改为「连同关联一起从召回移除，原子留下墓碑供历史召回」，中英同步。`docs/*/reference/tools.md.merged` 不含该句，未动 |
原断言是「概念进入前 3」，但概念种子分本身就最高，这条无法区分「修好了」和「概念本来就赢」。改为「钉住原本排第二的那条，断言它翻到第一」，反向验证才成立。
2. **上一轮声称「LTP 两条断言已加入 `decay.test.ts`」是错的**：两次插入都未匹配（锚点不存在），文件当时仍是原样。本轮用精确锚点补齐，现已确认 11 条断言在跑。

## 未做的与理由

- **不引入后台自动再巩固**：spec 既有边界明确否决（无法判断是否真的矛盾）。
- **不给概念加固定权重把首位拉满**：T7 实测 2/3 已达标，硬拉是拟合而非修问题。
- **不做模式分离**：T8 未测到干扰（两条冲突记忆都能召回、不被误合并）。

## 验证（最近一次全量）

- 记忆相关测试：**315 pass / 0 fail**，49 文件
- `bun run typecheck`：23 个 workspace 全 exit 0
- `bun run lint`：0 errors
- `check:no-comments`（2297 文件）、`check:boundaries`（1989 文件）、`check:deep-imports`、`check:t-coverage`：全绿
- 三档召回门禁：easy 1.000 / clustered 0.500·0.722 / sparse 0.833·0.583 未退化
