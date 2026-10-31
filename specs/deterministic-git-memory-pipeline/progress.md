# Progress — git 历史作为独立记忆模块

## 当前状态

设计已定稿（第 4 版），实施未开始。

| 项 | 状态 |
| --- | --- |
| requirements / design / tasks | 已写，待评审 |
| T1–T10 | 未开始 |
| token 观察（T10） | 未做，实施后补；**仅作观察，不作门禁** |

## 已确认的决策

| 议题 | 选择 |
| --- | --- |
| 形态 | 独立记忆模块，替代"人写 markdown / 从纠正学记忆"那一类；与系统提示**并存** |
| 注入方式 | **必须系统自动注入**，不得要求模型主动查询——存在不主动调用工具的模型 |
| 目标函数 | **任务总成本**，不是 token 数。改错一次回环比一份画像贵 12–35 倍 |
| 规模策略 | 不设 token/字符上限；优先保召回；只留"病态提交不铺开"一条抑制 |
| 组织方式 | 确定性规则，不做 LLM 摘要、不做向量检索 |

## 设计期的四次自我纠正

这一节是这份 spec 最有价值的部分：四条结论都是被追问推翻后重测得到的。

### 纠正 1：全局摘要"无用"的结论一半是排序造成的

按 PMI score 排，头部全是 `count=1` 的巧合（score 恒为 1.0），cap 400 对只覆盖 3.9%。**改按 count 排**，`count≥50` 只有 11 对、1085 字符，全是真不变量。结论：L1 是"不变量清单"，不是"分数最高的 N 对"。

### 纠正 2："目录级覆盖 66.3%"是我误读了自己的数据

那衡量的是"全图中存在共变目录"，不是"紧凑产物能覆盖多少"。紧凑化后（cap 15 对）只剩 3.9%，加到 400 对仍是 3.9%。

### 纠正 3：token 数不是字符数，不能用 token 做切分

仓库内没有真分词器：`estimateTokens` 是 `ceil(ASCII/4)+非ASCII`（`human/llm/tokens.ts:43`），`tokenx` 也只是字符比估算。不同模型分词器不同、计费不同，把 token 当切分单位没有技术依据。

### 纠正 4（最根本）：我在优化 token，而正确的目标是任务总成本

```
E[成本] = P(漏掉必改文件) × C(一次改错) + 注入量 × 1
```

一份文件画像 800–1700 token；改错一个文件的回环 20K–60K token、3–10 轮。比值 1:12 到 1:35。所以：

- 不设 token/字符上限；
- 优先保召回而非精度；
- 载荷从"3 个高精度伙伴"（召回 0.103）改为"3 组 change-group 的文件列表"（召回 0.463）——多花 1640 token 换 +36 个百分点。

## 实测证据

### 实验设置

1500 提交窗口；时间切分（train = 较老 851 个可用提交，test = 最新 212 个，过滤 2–30 文件的提交）。指标：用 train 段统计预测测试提交的文件集。

**天花板 0.639**：测试提交里 36.1% 的文件在 train 段从未出现（新文件）。

### 载荷对比

| 载荷 | 估计 token | 召回 | 精度 |
| --- | --- | --- | --- |
| 全局 top-500 共变对（score 排序） | ~1058 | 0.006（覆盖真实共变对） | — |
| 全局 top-5000 共变对（score 排序） | ~10500 | 0.037 | — |
| 全局目录图 cap 15（score 排序） | 276 | 0.039 | — |
| 全局目录图 cap 400（score 排序） | 8992 | 0.039 | — |
| 按文件最近 1 组 change-group 文件列表 | ~860 | 0.385 | 0.088 |
| **按文件最近 3 组 change-group 文件列表** | **~1660** | **0.463** | 0.053 |
| 按文件最近 10 组 change-group 文件列表 | ~2950 | 0.497 | 0.040 |
| 按文件最近 1 次变更压成目录 | 84 字符 | 0.647（**目录层**） | 0.202 |
| 3 个高精度伙伴（权重≥1 & score≥0.8） | ~20 | 0.103 | 0.651 |
| 前缀变更配方 topN=10 | 7.4 个路径 | 0.123 | 0.098 |

### 分布（决定"要不要设上限"）

10755 个文件：

| 指标 | p50 | p90 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- |
| 每文件 change-group 的目录数 | 12 | 56 | 63 | 63 | 17.8 |
| 每文件高精度伙伴数（未去团块） | 0 | 1 | 12 | 50 | 0.43 |
| 每文件高精度伙伴数（去团块后） | 0 | 0 | 3 | 3 | — |

高精度伙伴对 73% 的文件是空的，所以它只能是补充行。

### 去团块的必要性

未去团块时，`tools/review/build.zig` 及 4 个 baseline 文件各报 16 个伙伴，`_base/lifecycle/disposer.ts` 等 8 个文件各报 50 个伙伴——全部来自两个机械提交：`26eaf0cd71 style: format the source trees with oxfmt`、`1ab19190e9 refactor: strip comments from agent-core-v2…`。

去团块公式（每提交总权重 1）：

```
w(pair) = 1 / C(n,2)      w(x) = Σ 1/n      score = w(x,y) / sqrt(w(x)·w(y))
```

去团块后最大伙伴数 16 → 3。代价：召回 0.103 → 0.061——降掉的是"用批量提交预测批量提交"，属于对噪声的过拟合。

### 全局事实按 count 门槛的规模

| 门槛 | 对数 | 字符数 |
| --- | --- | --- |
| count ≥ 50 | 11 | 1085 |
| count ≥ 30 | 75 | 7434 |
| count ≥ 10 | 3020 | 344784 |
| count ≥ 5 | 48224 | 5993873 |

`count≥50` 头部：`i18n/locales/en.ts ↔ zh.ts`（63）、`docs/en/configuration/config-files.md ↔ docs/zh/…`（75）、`node-sdk/src/rpc.ts ↔ sdk-rpc-client-v2.ts`（59）。

### 成本实测（本仓库 3973 提交）

```
git log --format='%s'                    0.2s
git log -395 --name-only --format='%H'   0.9s
git log -395 --numstat --format='%H'     2.6s
git log --numstat --format='%H'         13.0s
```

触碰 >10 文件的提交 143/378（38%）、>30 文件 68/378（18%）；最大批量操作 `eb83a0c707` 删除 `apps/kimi-web`（356 文件 / 84,893 行删除）。

## 环境注意

- 本机 Git Bash 下 `sort` 解析到 `C:\WINDOWS\system32\sort.exe`，POSIX 语义不可用；统计脚本一律用 `awk` 或 Bun。
- `bunx` 会触发重新解析并改写 `bun.lock`（把 `apps/kimi-code` 从 2.3.3 拉到 2.4.0）。已 `git checkout -- bun.lock` 还原。实施中不要引入依赖变更。


## 外部参照（2026-10-31 补充）

同类项目已形成"Git for Memory"这一细分：GitOfThoughts（推理树即仓库）、agent-memory-git（记忆存为仓库内 markdown，钩子记录来源）、DiffMem（当前状态用 markdown、演变用 git 提交）、Git Context Controller（COMMIT/BRANCH/MERGE 操作上下文）、Memoria、Gitagent（智能体本身即仓库）。

它们的共识与本文档的实测互相印证：

- **git 记忆的价值在管理与追溯，不在提升召回。** 本文档实测召回天花板 0.639（36.1% 的文件在训练段从未出现）。
- 因此本 spec 的定位从"更好的仓库上下文"修正为"**可控的记忆模块**"：卖点可审计、可回滚、可合并、不腐坏。

这条参照直接导致两个设计结果：

1. **派生的仓库知识不套第二层 git**（D12）——源头就是 git，再加一份只会漂移。
2. **写入的记忆必须自带 git**（D11）——它原本没有版本，那才是真正的缺口。

## 拆分的第四次尝试（负结果）

试图把"单元"从原始提交换成更有语义的结构，测了三种：

| 拆法 | 召回 | 精度 | 无归属文件 |
| --- | --- | --- | --- |
| 共变图连通分量 score≥0.15 | 0.282 | 0.031 | 54.3% |
| 共变图连通分量 score≥0.20 | 0.221 | 0.147 | 60.5% |
| 共变图连通分量 score≥0.30 | 0.123 | 0.230 | 73.2% |
| 前缀变更配方 topN=10 | 0.123 | 0.098 | — |
| 目录共变图（cap 400） | 0.039（覆盖） | — | — |
| **按文件取原始提交（change-group）K=3** | **0.496** | 0.044 | — |

三种拆法在各自的最佳档位上都输给"单元 = 原始提交"。原因：这个仓库的变更是**跨切面**的（一个特性提交同时动实现、测试、i18n、文档），任何模块边界都会被跨过；且 54–82% 的文件在共变图里没有强边。

**结论：好的拆分不是"把提交拆细"，而是"单元用原始提交、键用文件路径"。** 这条已写进 `requirements.md` 的排除范围。

## 第二部分已并入（写入记忆的 git 化）

见 `requirements.md` R15–R21、`design.md` §12、`tasks.md` T11–T14。三条要点：

- `~/.kimi-code/memory` 变成 git 仓库，每次写入一次提交，author 固定、不出现 agent 身份；
- 提交失败**不掩盖**写入结果（文件已写入，但明确报告"未提交"）；
- 每条记忆必须声明 `applies_to`，否则无法自动注入、只能当文档——R1 的"不得依赖模型主动查询"同样适用于写入侧。


## 外部实现的真实阅读（2026-10-31 补充）

读了两个项目的源码，不是综述：

- `Growth-Kinetics/DiffMem`（Python，14806 行）：`storage/local_storage.py`（中央 git 仓库 + per-user 分支 + per-user worktree；post-commit hook 带哨兵注释、原地替换不覆盖用户自有 hook）、`repo_manager.py`（写永远不阻塞在远端备份上）、`frontmatter.py`（YAML frontmatter 是可查询字段的主要位置）、`retrieval_agent/agent.py`（多轮 LLM 检索 agent，单个 `run(command=...)` 工具）、`retrieval_agent/resolver.py`（`must_include` / `if_budget_allows` 两级 + 预算加载）。
- `faugustdev/git-context-controller`（Shell）：`SKILL.md`、`scripts/gcc_commit.sh`（真实 commit + 追加瘦索引项）、`scripts/gcc_context.sh`（`--summary` 纯解析索引、零 git 调用；`--last N` / `--hash` 才重建 git 细节；`--decisions` 只取带 note 的条目）。

### 读完后改了 spec 的三处

1. **负知识从"排除范围"移回一等公民**：GCC 的 `note` 字段专存 git 记不住的东西（否决的备选、取舍）。→ R22。
2. **注入载荷分档 + 优先级分层**：借鉴 DiffMem 的两级优先级与 GCC 的分档，但**预算单位改成字符数**（他们用 token，而 token 随模型分词与计费变化，不是产品级单位）。→ R24。
3. **注入只写观测、不写判断**：理由是用户指出的——**让 AI 参与注入就有不稳定性，再强的模型也会幻觉**。→ R25。

### 读完后否决的、包括我自己的方案

- **DiffMem 的检索 agent**（让主 agent 不查询、后台 agent 探索记忆仓库并产出注入计划）：它的计划是生成内容，会幻觉。**这正是我上一条准备采纳的方案，被这条否决了。**
- DiffMem 的服务端形态（FastAPI + per-user worktree + Hatchet 调度 + ontology 体系）、LLM 写实体与知识图谱式综合、GCC 的 worktree-per-branch 与 TTL 清理、GCC 的 aiyoucli 向量桥接——理由见 `design.md` §12.3。

### 读完后仍然成立的部分

两个项目的记忆都来自**人/agent 写的内容**，没有一个解决"从代码仓库历史推导仓库知识"。所以第一部分（派生，确定性规则）与第二部分（写入，git 化）确实是两个东西，spec 的两段结构不变。


## 第五版：注入内容收敛为 git 对象的原始投影（2026-10-31）

用户定的最后一条纪律：**连规则生成的描述也不行**——注入里只能出现 git 对象的原始引用（sha、commit message、路径列表）。

### 这条纪律带来的连锁变化

**删掉的**（全部是"计算出来的描述"）：共变对、共现计数、提交约定词汇表、不变量清单、高精度伙伴、目录压缩视图、模块划分。

**留下的**：该文件最近 3 个提交的原始投影（sha + 日期 + author + subject 原文 + 该提交的完整路径列表）。

### 关键发现：纪律与有效性指向同一个方向

被删掉的统计量形态，实测召回本来就极低：

| 被删的形态 | 实测召回 |
| --- | --- |
| 全局 top-500 / top-5000 共变对 | 0.006 / 0.037 |
| 全局目录共变图（cap 15 / 400） | 0.039 / 0.039 |
| 前缀变更配方 topN=10 | 0.123 |
| 共变图连通分量（模块） | 0.123–0.282 |
| 高精度共变伙伴 | 0.103 |

而留下的形态正是召回 **0.463** 的那个。所以这次收敛不是牺牲，是去掉一层**既违规又无效**的复杂度。

**副作用**：整个事实抽取层消失——不再有成对统计、不再有 PMI 归一化、不再需要去团块（去团块那条教训只对"计算成对统计"有意义，原始投影天然免疫）。模块名从 `gitFacts.ts` 改为 `projection.ts`（它不产出事实，只搬运对象）。

### 被否决的"外部方案"

DiffMem 的检索 agent（多轮 `run(command)` 探索记忆仓库、产出 ContentPointer 计划）——它确实让主 agent 不查询，但计划是**生成内容**，会幻觉（路径可能不存在、意图可能被编造）。这一条同时否决了我上一版准备采纳的方案。

### 唯一需要解释的地方

R4 要求注入内容是 git 对象的原始投影，而"人自由写的散文字段"不是 git 对象。所以写入侧加了一条（R23）：**人可自由写；agent 只能写引用型条目**（指向已存在的 sha + 原文引用）。这是"禁止用 AI 生成"在写入侧的推论，也是全 spec 唯一带解释性的一条需求。

### 成本模型未变

省 token 依然是错的目标（改错一次回环 20K–60K token，是一份画像的 12–35 倍）。R3 仍禁止按 token/字符裁剪；token 只作观察值。


## 实施记录（2026-10-31，第六版实施）

本节记录按本 spec 实施的结果、偏离与验证证据。

### 已实施

| 任务 | 状态 | 落点 |
| --- | --- | --- |
| T1 flag 与类型 | ✅ | `src/features/gitMemory/flag.ts`、`types.ts`（类型里无任何计数字段） |
| T2 取数 | ✅ | `gitReader.ts`：三条命令，`--no-renames`，`-c core.quotePath=false` |
| T3 缓存 | ✅ | `cache.ts`：按 HEAD 缓存，`byPath` 倒排索引指向每路径最近 3 个提交 |
| T4 投影 | ✅ | `projection.ts`：只排版，不统计 |
| T5 服务 | ✅ | `gitMemoryService.ts`：flag 门、两级去重、弃权、stale-while-revalidate |
| T6 L1 接线 | ✅ | `profile.ts` / `profile-shared.ts` / `system.md` / `profileService.ts` |
| T7 L3 接线 | ✅ | `agent/tools/fileMemory.ts` + Read/Edit/Write 三处 |
| T8 L2 接线 | ✅ | reminder variant `git_memory_signal` |
| T9 门禁 | ✅ | `check:git-memory`、`check:no-comments`、`check:locale-keys`、`check:t-coverage`、typecheck |
| T10 memory 仓库 | ⚠️ 部分 | `app/memory/memoryRepo.ts`：懒 `git init`，写入即提交，author 固定 `kimi-code memory <memory@local>`；条目落库时带 `sha`/`intent`/`applies_to`。**R25 要求的"独立瘦索引文件"未做**——见偏离 8 |
| T11 log / revert | ✅ | `Memory` 工具新增 `log` / `revert` 两个 action |
| T12 applies_to | ✅ | `memoryPaths.parseAppliesTo` + `picomatch` 匹配，命中进 L3、未声明进 L1 |
| T13 内容纪律 | ✅ | agent 写入必须引用一个已存在的 git 提交 sha，否则拒绝落盘 |
| T15 静态检查 | ✅ | `packages/agent-core-v2/scripts/check-git-memory-injection.mjs` + 同名 `.d.mts`，已接进 `ci.yml` 的 lint job |

### 实施期偏离（全部记在此处，未回头改设计结论）

1. **取数命令多了一个 `-c core.quotePath=false`。** git 默认会把非 ASCII 路径转义成 `\xxx`，那就不是"逐字来自 git"了。该选项保证路径原文。

2. **`rev-parse` 用三合一形式。** `git rev-parse --show-toplevel --show-prefix HEAD` 一次拿到**仓库根 / 工作目录相对仓库根的前缀 / HEAD sha**。原因是 git 输出的文件路径相对**仓库根**，而工具给的路径相对**工作目录**——两者在工作目录是仓库子目录时对不上，文件级注入会全部落空。

3. **`--no-renames` 是必需的。** 实测本仓库 1500 提交窗口：带重命名检测的 `--name-only` 扫描 3.25s，加 `--no-renames` 后 0.54s（6 倍）；端到端 3.45s → 0.84s。索引每次 HEAD 变化都要重算，这个成本必须压住。代价：改名文件丢失改名前的历史。

4. **缓存键加了两个字段**：`version` 与 `window`（原设计只有 `headSha`）。窗口变了同一 HEAD 下的索引也失效。

5. **写了记忆侧的第二部分时，发现"每文件每会话一次"这条去重规则要区分两类**：路径级（同一文件不重复注入）与提交级（同一提交被不同文件引用时只输出 `see commit <sha> above`）。两层共用一个会话内 `Set`。

6. **写入侧的自由散文被"引用型"规则挡住后，`Memory` 工具的行为在 flag 关闭时必须与今天逐字相同**——所以引用校验、提交、`log`/`revert` 全部由 `git_memory` flag 统一开关。spec 原文未要求对写入侧加 flag，这是为了满足 R15 的"flag 关闭时行为与今天逐字相同"。

7. **审计闭环的一个 git 限制**：`git revert` 不能回滚根提交。回滚第一条记忆会失败并被如实报告（不静默）。

### 验证证据

- 包级套件：改动前后**同一批 7 个文件失败**（既有失败，与本 feature 无关）；对比 T1 之前的提交逐条比对过失败名，差异仅为工作区里 environmentBinding 那批代码引起的清单漂移。
- 清单漂移已随代码同步（`gen:state-manifest` / `gen:wire-manifest`），生成差异**只含 environmentBinding 条目，不含本 feature 任何内容**——即本 feature 不改变 wire/state 契约。
- 真仓库实测：1466 提交、约定词汇表、12 条不变量全部来自原始 git 对象，注入文本零统计量、零祈使句，每行可用 `git show <sha>` 复核。
- 审计闭环实测：写入 → `git log` 可见 → `git show` 可看 diff → `revert` 可撤销，三步有单测覆盖。

### 未验证

- **token 增量尚未实测**：需要真实会话读 provider 的 `inputTotal(usage)`。按 R3 不得据此设任何阈值，只作观察。
- **行为效果未对照**：按本 spec 的纪律，上线前应做 flag 开/关的任务对照；本轮未做。
- **未提交本 spec 目录**（见提交说明）。

### changeset 判定

`git_memory` flag 默认关闭 → 默认用户感知不到 → 按 `CONVENTIONS.md:150` **不写 changeset**。若用户开启该 flag，则记忆写入会多一次提交、仓库体积会变化，属于可感知变化，届时再判定。


## 端到端验证（2026-10-31，真实会话）

用 `kimi -p` 跑真实 headless 会话，从落盘的 wire 记录里核对注入内容与 token 成本。

### 验证结果

| 项 | 结果 |
| --- | --- |
| L1（系统提示里的 `<repo-memory>`） | ✅ 出现在 AGENTS.md 块之后，内容是纯 git 原文 |
| L3（工具结果里的 `<file-memory>`） | ✅ 第一次验证**没出现**——见下方"发现的一个 bug"，修好后出现 |
| token 成本（L1） | flag 开 60978 / 关 60303 ⇒ **+675 token**（MiniMax-M3.1-Flash，同一提示各跑一次） |
| token 成本（L3） | 每次读文件 **+408 token**（第二轮 inputOther 678 → 1086） |

### 发现的一个 bug（端到端才暴露，单元测试漏掉）

`ReadTool` 有**两条执行路径**：正常文件读取（`execution()`）与附件/媒体读取（`attachmentExecution()`）。接线时只补了后者，**前者没补**——模型正常读文件走的是前者，所以 L3 完全没生效。

**为什么单元测试没抓到**：helper（`withFileMemory`）有单测、投影渲染有单测，但没有一条测试真的执行 Read 的主路径并断言结果里有注入块。

**修法**：主路径也包 `withFileMemory`；并补一条回归测试 `appends the git memory block to the read result`。该测试的有效性已验证：把主路径的服务改成 `undefined`（语法合法）→ 该测试失败；恢复 → 84 个用例全过。

**教训**：注入类接线必须有一条**端到端行为测试**（真的执行工具、真的看结果），只测 helper 等于没测接线。

### 未验证（仍待办）

- **flag 开/关的任务行为对照**：需要一批同类任务各跑多次，对比改动文件数、测试失败数、完成轮数。CommitDistill 的教训表明检索命中不等于任务变好，这个结论必须自己测。
- **L2（reminder 通道）**：只在用户消息里出现路径时触发，本轮未构造这样的会话验证。


### 偏离 8 — R25 的"独立瘦索引文件"未实现（实施期自查发现）

**R25 要求**：写入记忆用瘦索引形态，索引项 = `{ sha, intent, note, applies_to, date }`，**正文不复制进索引**，内容从 git 重建。

**实际做成的**：
- git 持有版本化真相（markdown 文件 + 每次写入一次提交）✓
- MiniDb 里的条目是**可重建的检索索引**（`reconcile()` 已能从磁盘文件重建）✓，语义上不是"第二份真相"
- 条目落库时带上 `sha`（写入那次提交）、`intent`（提交意图）、`applies_to`（从 front matter 解析）✓

**没做的**：**没有独立的瘦索引文件**（类似 GCC 的 `index.yaml`），因此正文仍在 MiniDb 条目里留了一份拷贝。这是既有 `memoryStore` 的结构（FTS 索引需要正文），改它要动既有检索路径与 `reconcile()` 语义，超出本轮改动范围。

**为什么要记下来**：本文件的"已实施"表原本把 T10 标成 ✅，属于 overclaim——R25 的核心诉求（避免两份真相）达成了，但字面要求的瘦索引文件没做。已把该行改成 ⚠️ 并在此说明。

**若要补齐**：写入时在内容提交之后再写一份 `index.json`（`{ path: { sha, intent, note, applies_to, date } }`）并单独提交一次（sha 必须晚于内容提交，否则自引用），读取时以该文件为元数据来源、以 git blob 为正文来源。
