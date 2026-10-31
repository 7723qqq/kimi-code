# Design — 把原始 git 部分蒸馏后注入上下文

需求与实测见 `requirements.md`。本文件给出蒸馏规则、落点、载荷格式与被否决的方案。

## 0. 一句话设计

**原始 git → 四条确定性规则 → 一份按 HEAD 缓存的投影 → 三层自动注入；模型零调用。**

```
git log --format=%s     ─┐
                         ├─► 规则（纯函数）─► 投影（按 HEAD 缓存，可随时重算）
git log --name-only     ─┘        │
                                  ├─ 蒸馏层 0：会话启动 —— 清单（路径 | sha | intent | 强度）
                                  ├─ 蒸馏层 1：文件进入视野 —— 该文件的 3 组 change-group
                                  └─ 蒸馏层 2：模型主动下钻 —— git show <sha>（模型本来就有 Bash）
```

**没有记忆存储层。** 蒸馏产物是 git 的**投影**：无写入生命周期、不可编辑、不腐坏（源头即真相，缓存可重算）。每项带源提交 sha，人能 `git show` 复核。

## 1. 目标函数

见 `requirements.md` §目标函数。要点：注入量与"改错的代价"差 12–35 倍，所以不设 token 上限、优先保召回。

## 2. 蒸馏规则

### 2.1 提交约定词汇表

`%s` 的前缀计数，取前 8。实测（1500 提交窗口）：`fix(agent-core-v2)` 121、`feat(agent-core-v2)` 74、`fix` 58、`refactor(agent-core-v2)` 36、`docs` 35、`chore` 32。

### 2.2 共变必须排除机械提交，且相似度与提交规模无关

**最重要的一条数据质量规则。** 一个触碰 n 个文件的提交会给它的全部 `n(n-1)/2` 个文件对各加 1 次共现，于是大规模机械提交（格式化、去注释、批量重命名、依赖升级）生成完全图。

实测证据：未处理时，`tools/review/build.zig` 及其 4 个 baseline 文件各报 **16 个伙伴**，`_base/lifecycle/disposer.ts` 等 8 个文件各报 **50 个伙伴**——来自 `26eaf0cd71 style: format the source trees with oxfmt` 与 `1ab19190e9 refactor: strip comments from agent-core-v2…`。

规则两步：

**第一步：排除机械提交。** 触碰文件数 > `GIT_MEMORY_MAX_FILES_PER_GROUP`（25）的提交不参与共变统计（但仍进 change-group，只报摘要）。本仓库 1500 个提交里排除 281 个，剩 1219 个。

**第二步：成员集上的余弦。**

```
A_x            = 触碰过 x 的提交集合
score(x, y)    = |A_x ∩ A_y| / sqrt(|A_x| · |A_y|)
```

永远同行的两个文件得 1.0，**与提交规模无关**。这一步同时废掉了"按文件数过滤提交"的旧代理做法。

**门槛**：伙伴 `count ≥ 5 且 score ≥ 0.8`；不变量 `count ≥ 5 且 score ≥ 0.9`，按 count 降序取前 12。

实测（1500 提交窗口）：不变量 12 对，头部为 `docs/en/configuration/config-files.md ↔ docs/zh/…`（39 次）、`docs/en/release-notes/changelog.md ↔ docs/zh/…`（34）、`apps/kimi-code/src/i18n/locales/en.ts ↔ zh.ts`（30，score 1.000）；每文件伙伴数 p50=0、p99=1、max=5、mean 0.05、96.7% 的文件没有伙伴——hub 假象消失。

### 2.3 不变量（蒸馏层 0 的原料）

`count ≥ 50` 且 `score ≥ 0.3` 的文件对，按 count 降序。实测本仓库 11 对。

**必须按 count 排序，不能按分数排序**——按 PMI 分数排的头部全是 `count = 1` 的巧合（score 恒为 1.0），cap 400 对只覆盖 3.9%。

### 2.4 change-group（蒸馏层 1 的原料）

对每个文件，取最近 **3** 次触碰它的提交，各记一组：sha、subject、日期、文件列表。

为什么是文件列表而不是压缩成目录：压成目录 84 字符能达 dirRecall 0.647，但那只是**目录层面**的完整；文件层面 3 组列表的召回是 0.463，压成目录后目标也变得模糊。按成本模型取信息更完整的文件列表。

为什么是 3 组：0.463 → 0.497 的边际收益（10 组）要 1290 token。

### 2.5 高精度伙伴（补充行）

`权重 ≥ 1` 且 `score ≥ 0.8`：precision 0.651，**73% 的文件一条都没有**。作为可选行出现，有则加，没有整行省略。

### 2.6 强度（清单的排序键）

代码拥有，不来自自由文本：`strength(x) = 归一化(近期改动次数) + 归一化(最近改动距今天数)`。只用于清单排序，不参与任何比较分支。

## 3. 三层注入与载荷

### 3.1 蒸馏层 0 — 会话启动（系统提示）

模板变量 `${repo_memory}`，位置在 `${agents_md}` 之后。flag 关闭时渲染为 `''`。

```
<repo-memory>
# path | last-change sha | intent | strength
packages/agent-core-v2/src/agent/profile/profileService.ts | 9b5ca3b | fix(loop): record the per-step cache observation | 9
packages/agent-core-v2/src/app/agentProfileCatalog/system.md | 4b0b3b1 | refactor(tui): move todo panel toggling out of the editor | 6
...
Always change together (>=50 commits):
  i18n/locales/en.ts <-> zh.ts
  docs/en/configuration/config-files.md <-> docs/zh/configuration/config-files.md
  node-sdk/src/rpc.ts <-> sdk-rpc-client-v2.ts
</repo-memory>
```

**清单形态，不是散文。** 外部实现都这么做（DiffMem 的 `index.md` = names/cues/strength/paths；GCC 的 `index.yaml` = hash+intent；Encephalon 的 baseline = 有界清单且明确不遍历源码树）。

### 3.2 蒸馏层 1 — 文件进入视野（工具结果尾部，主通道）

`Read` / `Edit` / `Write` 命中某文件时，在工具结果末尾追加：

```
<file-memory path="apps/kimi-code/src/tui/tui-state.ts">
Change 1 (9b5ca3b, 2026-10-30, refactor(tui)) touched 9 files:
  tui/components/chrome/footer.ts, tui/controllers/session-event-handler.ts,
  tui/kimi-tui.ts, i18n/locales/en.ts, ...
  -> git show 9b5ca3b --stat
Change 2 (4b0b3b1b1c, 2026-10-30, refactor(tui)) touched 5 files:
  ...
  -> git show 4b0b3b1b1c --stat
Change 3 (...):
  ...
Usually changes with: i18n/locales/en.ts
</file-memory>
```

每组都带 `git show <sha> --stat` 指针——**不新增工具**，模型本来就有 Bash。深挖是可选附加层。

### 3.3 蒸馏层 2 — 模型主动下钻

模型拿着 3.1/3.2 里的 sha 自己跑 `git show` / `git log --stat`。这一层是**分发出去的原图**，没有额外加工。

三层的成本阶梯与 GCC 的 `gcc_context.sh`（`--summary` / `--last N` / `--hash` / `--full`）同构，区别是这里的第一层不是"用户主动调用"，而是**系统自动在场**。

### 3.4 唯一的"不铺开"规则

单组提交触碰文件数 >25 时，不铺开列表，只报 `sha + subject + 日期 + 文件数 + 主要目录`。这类提交是批量操作（格式化、重命名），铺开没有信息量。与 §2.2 的去团块是同一件事的两个出口。

## 4. 索引与缓存

```json
{
  "version": 1,
  "repoRoot": "/abs/path",
  "headSha": "…",
  "window": 1500,
  "computedAt": "ISO-8601",
  "facts": {
    "conventions": [{ "prefix": "fix", "count": 149 }],
    "invariants": [{ "a": "…", "b": "…", "count": 63 }],
    "fileChanges": { "…": [{ "sha": "9b5ca3b", "subject": "…", "date": "…", "files": ["…"] }] },
    "filePartners": { "…": [{ "path": "…", "weight": 2.7, "score": 0.91 }] }
  }
}
```

- **命中**：`version` 与 `headSha` 相同 → 直接读缓存，**不 spawn 任何 git 进程**。
- **未命中**：窗口扫描（`%s` 0.2s + `--name-only` 0.9s，窗口 1500），写缓存再渲染。
- **不增量**：增量合并要处理滚动窗口淘汰与权重回退，收益抵不上复杂度；一次重算 1.1s。
- 每个文件最多存 3 组 change-group，索引因此有界。
- 缓存是**可丢弃的派生数据**：删掉会重算，不会丢信息（这是"投影不是事实源"的直接体现）。

## 5. 落点

新目录 `packages/agent-core-v2/src/features/gitMemory/`（与 `features/tower/` 同构）：

| 文件 | 职责 |
| --- | --- |
| `flag.ts` | `registerFlagDefinition('git_memory', { default: false })` |
| `types.ts` | `GitMemoryIndex`、`Invariant`、`ChangeGroup`、`Partner`、`Strength` |
| `gitFacts.ts` | 纯函数：约定词汇表、去团块加权、不变量、每文件 3 组 change-group、高精度伙伴、强度 |
| `gitReader.ts` | 只跑 `rev-parse HEAD`、`log -N --format=%s`、`log -N --name-only`，带超时与失败分类 |
| `cache.ts` | 读写 `<repo>/.kimi-code/git-memory.json` |
| `render.ts` | `facts → 三段文本`，纯函数 |
| `gitMemoryService.ts` | agent 作用域服务，暴露 `repoBlock()`、`signalBlock(text)`、`fileBlock(path)` |

改动的既有文件：

| 文件 | 改动 |
| --- | --- |
| `agent/profile/profile.ts` | `AgentProfileContext` 增 `repoMemory?: string` |
| `app/agentProfileCatalog/profile-shared.ts` | `systemPromptVars` 增 `repo_memory` |
| `app/agentProfileCatalog/system.md` | `${agents_md}` 之后增一行 `${repo_memory}` |
| `agent/profile/profileService.ts` | 注入 `IGitMemoryService`，取 `repoBlock()` |
| `agent/tools/os/read/readTool.ts` | 结果组装处（`:291` 的 `withAttachmentLocation` 旁）追加 `withFileMemory(...)` |
| `agent/tools/edit/editTool.ts` | 同上 |
| `agent/tools/os/write/writeTool.ts` | 同上 |
| reminder 注册点 | 新增 `repo_memory_signal` variant，实现 L2 |

**L3 复用既有写法**：`fileReadSource.ts:15-25` 的 `withAttachmentLocation` 就是"给工具结果追加上下文"的现成模式；新增 `withFileMemory(result, path, service)` 放同模块旁，三个工具各调一次。

**为什么不在 `toolExecutorService` 统一拦截**：那里只有 `args`，没有可靠的"受影响路径"语义（MCP 工具参数形状各异）。逐个工具显式接线更安全，也符合既有先例。

**为什么 L0 不写进 AGENTS.md**：Encephalon 确实把指针写进 AGENTS.md 的托管块（`<!-- encephalon:managed-instructions:begin/end -->`，可逆移除，1 MiB 文件上限）。但那是**可提交、可分享**的产物，适合"人写的东西"；本 spec 的层 0 是**从 git 派生**的，必须始终新鲜，写进工作区文件会变成需要用户提交的陈旧副本。所以层 0 留在系统提示层。

## 6. 注入协议

| 项 | 规则 |
| --- | --- |
| 去重 | **两级**：每文件每会话一次；同一 change-group 的文件列表每会话只铺开一次，后续输出 `see change <sha> above` |
| 顺序 | `<file-memory>` 追加在工具结果**末尾**，不改变原有输出的任何一行 |
| 上限 | **不按 token/字符裁剪**。唯一规模约束是 §3.4 的病态提交规则与每文件 3 组 change-group |
| 优先级 | 由代码常量标注（`must_include` / `if_budget_allows`），不来自模型自由文本 |
| token | 只作**观察值**：用 provider 返回的 `inputTotal(usage)`（`human/llm/usage.ts:13`）记录实际增量，写进 `progress.md`；不作门禁 |
| 空段 | 任一段无内容则整行省略，不留空标签 |
| 语言 | 英文（C2 模型资产），不翻译、不加 locale key |

## 7. 与既有机制的关系

| 机制 | 管什么 | 本 spec 的处理 |
| --- | --- | --- |
| `<git-context>`（`gitContext.ts`） | 工作区快照：分支、dirty、最近 3 条提交 | 不动。本 spec 是历史蒸馏 |
| `Memory` 工具（`app/memory/`） | 可被模型显式读写的 markdown 记忆 | **不写、不注入**。它属于另一个课题 |
| knowledge 层（`agent/knowledge/`） | 从用户纠正语学到的规范 | 不写。注入预算互不挤占：knowledge 走 reminder，本 spec 走系统提示与工具结果 |
| `features/fileHistory/` | 文件备份与 checkpoint（撤销用） | 无关，只是名字相近 |
| `packages/transcript` | 会话行为轨迹 | 不合并 |

## 8. 外部实现对照（读源码，非 README）

完整阅读过：`Growth-Kinetics/DiffMem`（`CONTEXT.md`、`frontmatter.py`、`repo_manager.py`、`retrieval_agent/agent.py`、`retrieval_agent/prompts/system.txt`、`writer_agent/CONTEXT.md`）、`faugustdev/git-context-controller`（`SKILL.md`）、`isaachinman/encephalon`（`README.md`、`src/instructions.ts`、`src/canonical-budgets.ts`）、`aoci-spec/aoci-code`（`docs/cognition-volumes.md`、`internal/cognition/`）。另有 `mex-memory/mex`、`entireio/entire-brain`、`zhangfengcdt/memoir`、`Ghost-xDD/memforks`、`Guuzzeji/mnemo`、`open-gitagent/gitagent`、`forjd/aid` 未逐行读。

### 8.1 采纳

| 来源 | 采纳内容 | 落到 |
| --- | --- | --- |
| DiffMem / GCC / Encephalon | 索引是**结构化清单**，不是散文 | 层 0 清单形态（R7） |
| DiffMem / GCC | 检索给**指针**不给内容；指针按成本分级 | 层 1 带 `git show` 指针（R8）、三层成本阶梯 |
| DiffMem | 自由文本会绕过过滤器，必须代码拥有（`canonicalize_status()`） | 优先级用代码常量（D13） |
| Encephalon | 预算用**字节与条数**，不用 token（`recordBytes 1 MiB` / `records 1000`） | 佐证 R3 |
| Encephalon | 派生事实无写入生命周期，索引可丢弃 | 层 0/1/2 的投影定位（D11） |
| aoci-code | 派生视图（Impact / Evolution）无写入与恢复生命周期，是只读投影 | D11 |
| aoci-code | 影响图（impact graph）作为一等派生图 | 共变图即"影响图" |
| aoci-code | 只读的 repair findings 扫描 | 见 T12 |
| DiffMem / GCC | 非 git 时降级 | R12 |
| GCC | 提交意图（intent）是指针之外的必要信息 | 层 0 的 intent 列 |

### 8.2 冲突与裁决

| 冲突 | 对方 | 本 spec | 裁决 |
| --- | --- | --- | --- |
| 检索由谁发起 | 两家都靠模型主动查询 | R1 禁止依赖 | **都要**：层 0/1 自动注入且不依赖深挖；层 2 是可选附加层，模型本来就有 Bash |
| token 预算 | DiffMem 显式 token 预算 + 两级优先级 | R3 禁止按 token 裁剪 | 不采纳 token 截断；**采纳优先级标注**，由模型选层 |
| 载荷粒度 | DiffMem 用文件行段 + diff | 用提交的文件列表 | 保留文件列表（实测召回 0.463），另加 sha 指针让模型自行降到行段级 |
| 记忆粒度 | DiffMem 是实体（人 / 项目 / 主题） | 文件 / 目录 | 保留文件粒度：这是代码仓库，不是对话画像 |
| 写入型记忆 | DiffMem / Encephalon 都有 | 本 spec 不做 | 范围之外（R24/D11 的投影定位） |
| 向量检索 | GCC 做成可选桥接 | 不做 | 一致（D9） |

### 8.3 这轮对照暴露的我方案的三处错误（已修）

1. **层 0 写成散文而不是清单** → R7。
2. **只给了内容，没给"怎么拿到更多"** → R8（带 `git show` 指针，不新增工具）。
3. **把"注入通道"和"记忆存储系统"混成一件事** → 本版把范围收回到注入通道，明确排除写入型记忆。

## 9. 被否决的方案

- **按 token/字符裁剪注入量**：目标函数错位；且 token 随模型而变。
- **让模型主动查询作为主通道**：存在不主动调用工具的模型（R1）。
- **全局摘要覆盖全部知识**：score 排序下 cap 400 对、8992 token 只覆盖 3.9%；count 排序能拿到的只有 11 条不变量。
- **压成目录作为主载荷**：dirRecall 0.647 只是目录层的完整，文件层信息丢失。
- **把提交拆成更小的单元**：四次尝试全负（见 `requirements.md` 实测）。
- **向量检索**：无 embeddings 客户端、MiniDb 无向量索引；结构信号已近天花板。
- **LLM 摘要**：成本随历史线性增长、有损，根因不变。
- **改 `knowledge` schema**：`sqliteKnowledge.ts:48` 有 CHECK 约束、无迁移机制。

## 10. 测试策略

- `gitFacts.ts`（纯函数）：约定计数；**去团块权重**（10 文件提交对每对只贡献 1/45，2 文件提交贡献 1）；不变量只留 count≥50 且 score≥0.3；每文件只留最近 3 组 change-group 且按时间降序；伙伴 `权重≥1 且 score≥0.8`；空输入不抛；同输入结果深度相等。
- `gitReader.ts`：注入假进程，断言三条命令参数、超时分类、`not a git repository` 分类。
- `cache.ts`：同 HEAD 零进程；HEAD/version 变化未命中；损坏 JSON 重算。
- `render.ts`：>25 文件的提交只报摘要不铺开；空段省略；清单可逐行解析；**不按字符或 token 裁剪**（构造长输入断言条目全在）。
- `gitMemoryService.ts`：flag 关闭时零进程且三段都返回 `''`。
- 工具接线：flag 关闭时 `Read`/`Edit`/`Write` 输出逐字不变；同一文件第二次不重复附加；同一 change-group 第二次不重复铺开；工具失败时不附加。


## 11. 引用核验与校准（2026-10-31）

### 11.1 CommitDistill（arXiv:2605.18284v1）——最有用的一篇，也是最该警醒的一篇

摘要原文的要点（逐字核对，非转述）：

- 方法：**确定性正则**从本地 git 历史挖出**类型化知识单元（Facts / Skills / Patterns）**，**无 LLM、无 embedding、无外部依赖**；通过 **TF-IDF 检索器**在预算约束下暴露，带**弃权阈值 θ=2.5**（对分布外查询主动弃答）；存储是可检查的纯 JSON。
- 规模：25,000 提交、1,167 个抽取单元（≈4.7% 产出率）；**10,000 提交 < 4 秒**。
- **检索指标（强）**：256 字符/查询预算下，命中率 **0.750**，对比 BM25 **0.333**、`git log --grep` **0.083**。
- **质量指标（中）**：抽取单元的"有用比例" **0.525**（Cohen's κ=0.633，40 条 Python 单元双标注）。
- **效果指标（负，且是决定性的）**：n=200 时间旅行修 bug、四臂配对 LLM-as-judge（control / CommitDistill / CD-Hybrid / BM25），**主指标上没有任何条件相对 control 产生统计可检测的提升**；CD-Hybrid 与 BM25 正面比较无差异。

**这三条对本 spec 的影响：**

1. **检索指标不是效果证据。** 0.750 vs 0.083 说明"密集蒸馏 + 检索"在紧预算下确实远胜 grep——这印证了"信号密度"这个直觉。但它**没有**转化成任务变好。所以本 spec 不得承诺"减少漏改"，只能说"以可验证的方式把密集信号送达"，并用行为对照去检验（R17、T15）。
2. **0.525 的有用比例是警告。** 从 git 历史里蒸馏出来的知识单元，近一半人工判定无用。所以本 spec 的蒸馏产物必须**可逐条溯源**（带 sha）并**能被弃权**（R16）——坏单元必须能被识别出来，而不是混在注入里稀释信号。
3. **紧预算下密集形式占优。** 这条支持"在预算内最大化信号密度"。但本 spec 的实测给出的结论更精确：同一批数据，**文件级**载荷 3 组 change-group 召回 0.463（~1660 token），**目录级**压缩载荷 84 字符召回 0.647。两者的差别不是"要不要紧预算"，而是"哪个维度上信息密度更高"——目录维度上更高，文件维度上更完整。**因此两个密度都要有**：密集层给方向，完整层给"漏改"兜底。

### 11.2 Pydantic AI #9150「Git History as Compressed Context」——真实提案，但其中一条引用不成立

**已核实为真**：issue 存在（2026-03-21 提出，assignee 为 pydantic-ai 维护者 mpfaffenberger），设计完整：

```
GitContext { recent_commits, active_branches, uncommitted_changes,
              file_change_frequency, recent_authors }
CommitSummary { hash, message, author, timestamp, files_changed, insertions, deletions }
GitContextExtractor.extract(max_commits=20, since=7d, relevant_paths=None)
                      .to_compressed_text(ctx, max_tokens=500)
GitHistory(AbstractCapability): get_instructions() + before_model_request 刷新钩子
```

它明确把自己与四件相邻的事区分开：git 操作**工具**（#9128）、仓库结构**地图**（#9137）、对话**压缩**（harness#21）、静态文件注入（harness#64）。核心主张是：**git 历史压缩成独立 context 流，与系统提示和对话历史分离，从而支持独立缓存与独立 token 计量**；并援引 pi-mono 的文件操作跟踪（`<read-files>` / `<modified-files>` 写进压缩摘要）。

**不成立的一条**：issue 声称"Aider 首创了把 git 历史当压缩上下文"，并引用 `aider/repo.py` 的 `get_commit_hashes` 与 `aider/chat_chunks.py` 的 Git ChatChunk。**逐行核对 aider 源码后：**

| issue 的说法 | 实际情况 |
| --- | --- |
| `aider/repo.py` 有 `get_commit_hashes` | **不存在**（`get_rel_repo_dir` 确实存在，`repo.py:320`） |
| `aider/chat_chunks.py` 有 Git ChatChunk | `ChatChunks` 的 `repo` 字段是 **repo map（文件树+签名）**，不是提交历史 |
| Aider 把 git 历史注入 prompt | **整个 aider 代码库没有一处 `git log`**；`base_coder.py` 里的 commit 全是"自动提交" |

**Aider 真正的贡献是另一件事**：分块上下文架构 + 每块独立的 cache 控制（`ChatChunks.add_cache_control_headers`）。#9150 想要的"独立缓存与独立 token 计量"正来自这里——**不是来自 git 历史注入**。这个区分很重要：它意味着"独立缓存"是**架构能力**，与"内容是不是 git 历史"无关。

**对本 spec 的影响：**

- **"独立 context 流"在 kimi-code 的等价物是"内容只依赖 HEAD，不依赖对话"。** 我们的层 0 本来就是 `(repoRoot, headSha, window, version)` 的纯函数 ⇒ 同一 HEAD 下系统提示逐字相同 ⇒ 跨会话命中 cache。这正是"独立缓存"的落地方式，而不需要新协议。
- **独立 token 计量**：本 spec 不用 token 截断（R3），但要把 git 块的体积**单独记账**，不与对话预算混算。
- **pi-mono 的文件跟踪**：kimi-code 已有等价物——Read/Edit/Write 工具知道路径，`features/fileHistory/` 已跟踪 touched 文件。本 spec 的层 1 正是把这个跟踪接上 git 历史。
- **`file_change_frequency` 与 `recent_authors`**：可加可不加。加 `file_change_frequency` 成本几乎为零（`--name-only` 已在算）；`recent_authors` 需要额外取数（`%an`），且"谁在改"对模型的用处边际，本 spec 暂不做。

### 11.3 Structured Contextual Distillation（SCD v3.1）——已核验（此前记为"查不到"，此处更正）

论文本体已读（`Downloads/SCD_v31_Academic_Paper.pdf`，22 页）：

> **Structured Contextual Distillation (SCD v3.1): A Deterministic, Vendor-Independent Protocol for Persistent, Verifiable Agent State**
> Paul Desai, ActiveMirrorOS Research, Goa, India · 2025-12 · v3.1 "Universal Passport Edition"
> 状态自述："Production-Validated (N=1005 + Cross-Vendor + Adversarial Defense)"

**它是什么**：把 agent 状态从模型内部搬到文件系统，作为一等可审计产物。六大支柱：External / Canonical（RFC 8785 JSON 规范化）/ Deterministic（turn-based、版本号单调）/ **Governed** / Vendor-Independent / Tamper-Evident（SHA-256 完整性链）。

**验证范围（§6.1–§6.2，必须看清）**：Mac Mini M4 / macOS 15；Gemini 3 Pro（API）+ Claude 4.5 Opus（MCP 文件系统）；Tier 1 是**逐个协议操作隔离测试**（状态初始化、带校验和读取、turn 递增、宪法锁激活与强制、RFC 8785 规范化下的校验和计算、原子文件替换的 supersession）。所谓"1005 次转换 100% 确定性"指的是**协议的状态序列化与转移函数在相同输入下字节一致**——**不是 agent 任务效果**。这与 CommitDistill 的教训同构：确定性 ≠ 有用。

**它自陈的局限（§9.1）**：单 agent 串行假设；**不支持分支历史**（明说 VCS 常见的分支历史是未来方向，可能要 Merkle 树）；无语义查询；治理约束需手工配置、不能自动学习；规模未验证（状态只有 KB 级）。

**它自己声明不做的事（§3.4）**：不替代 RAG / 语义检索 / 关系模型；"这些能力可以与 SCD 并存，只是超出协议范围"。这与我们把"派生注入"与"记忆存储"拆开的判断一致。

### 11.4 SCD 对本 spec 的三条可迁移结论

**结论一（最重要）：注入内容是不可信数据。**
SCD §3.3 的论证直接命中本 spec：*"system prompts are fundamentally advisory—they can be overridden, forgotten, or circumvented through prompt injection"*；SCD 因此把治理放在**协议层**（推理之前的过滤），而不是提示层。

我们的处境更具体：**commit subject 是任何人都能写进仓库的文本**。把它原样注入系统提示与工具结果，等于我们的功能自己开了一条注入通道——一个写着 "IGNORE ALL PREVIOUS INSTRUCTIONS…" 的提交标题就够了。现有 `<git-context>` 只注入 3 条标题（`gitContext.ts:60`），风险有限；本 spec 会注入更多条，必须按数据处理。

→ **R20**：净化（剥离控制字符）+ 截断 + 数据标记 + **不写祈使句**。

**结论二：不要写"模型必须照做"的句子。**
既然提示是建议性的、且本功能的价值不该依赖模型顺从度（SCD 的"治理在协议层"精神），注入文本只陈述事实："这 4 个文件在最近 5 次提交里一起被改过"，而不是"你必须同时改这 4 个文件"。前者是信息，后者是不可靠的指令。→ **R19/R22**。

**结论三：逐字节可复现要落到数值格式上。**
SCD 用 RFC 8785 保证 JSON 逐字节一致。我们的蒸馏产物是**渲染文本**，没有 JSON 规范化可用；等价约束是：**不透传原始浮点数**（比例、分数按固定小数位格式化），否则同一份事实可能渲染出不同的字符串。→ **R21**。

**结论四（反向确认）：SCD 反而印证了我们不做记忆存储层的判断。**
它的目标是"可编辑、可版本化、可跨厂商携带的 agent 状态"；我们的目标是"不可编辑、可重算的投影"。两者不是同一件事，混在一起就会同时丢掉 SCD 的可编辑性和我们的新鲜性。

### 11.5 引用核验方法本身的教训

本轮三条引用里：一条真实但含一处失真引用（Aider）、一条真实且含决定性负结果（CommitDistill）、一条**当时查不到、后来由用户提供了 PDF 本体才核实**（SCD）。**"听起来对"和"读过源码"之间隔着具体的行号**——而"查不到"本身也不是结论，只是当时搜索手段不够。所以本 spec 对外部结论一律分级标注（R19），并保留"当时的状态"与"后来的更正"两段记录。
