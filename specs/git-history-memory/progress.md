# Progress — 把原始 git 部分蒸馏后注入上下文

## 当前状态

设计已定稿（第 5 版，含范围纠正），实施未开始。

| 项 | 状态 |
| --- | --- |
| requirements / design / tasks | 已写，待评审 |
| T1–T13 | 未开始 |
| token 观察（T13） | 未做，实施后补；**仅作观察，不作门禁** |

## 范围（第五版纠正）

本 spec 只做**注入通道**：原始 git → 部分蒸馏 → 上下文。

**写入型记忆系统被移出范围。** 早期版本把"记忆存储系统（可被 AI 编辑）"和"注入通道"混成了一件事，第五版拆开：前者是另一个课题（`Memory` 工具 + `app/memory/` 已存在），即使它存在，注入的也不是它。

同时移出范围的还有"给记忆加 git 版本"——那是写入侧的事，不影响注入侧。

## 已确认的决策

| 议题 | 选择 |
| --- | --- |
| 形态 | 原始 git → 四条确定性规则 → 按 HEAD 缓存的投影 → 三层自动注入，模型零调用 |
| 注入方式 | **必须系统自动注入**，不得要求模型主动查询——存在不主动调用工具的模型 |
| 目标函数 | **任务总成本**，不是 token 数。改错一次回环比一份画像贵 12–35 倍 |
| 规模策略 | 不设 token/字符上限；优先保召回；只留"病态提交不铺开"一条抑制 |
| 深挖 | 用模型已有的 Bash（`git show <sha>`），**不新增工具** |
| 组织方式 | 确定性规则，不做 LLM 摘要、不做向量检索 |

## 设计期的五次自我纠正

这一节是这份 spec 最有价值的部分。

### 纠正 1：全局摘要"无用"的结论一半是排序造成的

按 PMI score 排，头部全是 `count=1` 的巧合（score 恒为 1.0），cap 400 对只覆盖 3.9%。**改按 count 排**，`count≥50` 只有 11 对、1085 字符，全是真不变量。

### 纠正 2："目录级覆盖 66.3%"是我误读了自己的数据

那衡量的是"全图中存在共变目录"，不是"紧凑产物能覆盖多少"。紧凑化后（cap 15 对）只剩 3.9%，加到 400 对仍是 3.9%。

### 纠正 3：token 数不是字符数，不能用 token 做切分

仓库内没有真分词器：`estimateTokens` 是 `ceil(ASCII/4)+非ASCII`（`human/llm/tokens.ts:43`）。不同模型分词器不同、计费口径不同。外部实现也印证：Encephalon 的预算单位是**字节与条数**（`recordBytes 1 MiB`、`records 1000`），不是 token。

### 纠正 4（最根本）：我在优化 token，而正确的目标是任务总成本

```
E[成本] = P(漏掉必改文件) × C(一次改错) + 注入量
```

一份画像 800–1700 token；改错一个文件的回环 20K–60K token、3–10 轮。比值 1:12 到 1:35。于是不设上限、优先保召回，载荷从"3 个高精度伙伴"（召回 0.103）改为"3 组 change-group 的文件列表"（召回 0.463）。

### 纠正 5（范围）：把"注入通道"和"记忆存储系统"混成了一件事

用户明确：注入的是**原始 git 的蒸馏**，不是记忆存储系统；记忆或许能被 AI 编辑，但那不是要注入的东西。第五版把范围收回到注入通道。

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

### 拆分的四次尝试（全负）

| 拆法 | 召回 | 精度 | 无归属文件 |
| --- | --- | --- | --- |
| 共变图连通分量 score≥0.15 | 0.282 | 0.031 | 54.3% |
| 共变图连通分量 score≥0.20 | 0.221 | 0.147 | 60.5% |
| 共变图连通分量 score≥0.30 | 0.123 | 0.230 | 73.2% |
| 前缀变更配方 topN=10 | 0.123 | 0.098 | — |

结论：**单元 = 原始提交，键 = 文件路径**。不要再往"拆细提交"上投入。

### 分布

10755 个文件：

| 指标 | p50 | p90 | p99 | max | mean |
| --- | --- | --- | --- | --- | --- |
| 每文件 change-group 的目录数 | 12 | 56 | 63 | 63 | 17.8 |
| 每文件高精度伙伴数（未去团块） | 0 | 1 | 12 | 50 | 0.43 |
| 每文件高精度伙伴数（去团块后） | 0 | 0 | 3 | 3 | — |

### 去团块的必要性

未去团块时，`tools/review/build.zig` 及 4 个 baseline 文件各报 16 个伙伴，`_base/lifecycle/disposer.ts` 等 8 个文件各报 50 个伙伴——来自 `26eaf0cd71 style: format the source trees with oxfmt` 与 `1ab19190e9 strip comments from agent-core-v2…`。

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

### 成本实测（本仓库 3973 提交）

```
git log --format='%s'                    0.2s
git log -395 --name-only --format='%H'   0.9s
git log -395 --numstat --format='%H'     2.6s
git log --numstat --format='%H'         13.0s
```

触碰 >10 文件的提交 143/378（38%）、>30 文件 68/378（18%）；最大批量操作 `eb83a0c707` 删除 `apps/kimi-web`（356 文件 / 84,893 行删除）。

## 外部实现对照（读源码，非 README）

**逐行读过**：`Growth-Kinetics/DiffMem`（`CONTEXT.md`、`frontmatter.py`、`repo_manager.py`、`retrieval_agent/agent.py`、`retrieval_agent/prompts/system.txt`、`writer_agent/CONTEXT.md`）、`faugustdev/git-context-controller`（`SKILL.md`）、`isaachinman/encephalon`（`README.md`、`src/instructions.ts`、`src/canonical-budgets.ts`）、`aoci-spec/aoci-code`（`docs/cognition-volumes.md`、`internal/cognition/`）。

**只读了 README/定位**：`mex-memory/mex`（1784★）、`entireio/entire-brain`、`zhangfengcdt/memoir`、`Ghost-xDD/memforks`、`Guuzzeji/mnemo`、`open-gitagent/gitagent`、`forjd/aid`。

### 三条可直接抄的工程结论

1. **索引是结构化清单，不是散文。** DiffMem 的 `index.md` = names/cues/strength/paths；GCC 的 `index.yaml` = hash+intent；Encephalon 的 baseline = 有界清单且**明确不遍历源码树**。
2. **检索给指针不给内容，且指针按成本分级。** DiffMem 的指针类型 `file_section` / `git_diff` / `git_log` / `file`；GCC 的 `--summary` / `--last N` / `--hash` / `--full`。本 spec 的三层蒸馏与之同构。
3. **自由文本会绕过过滤器，必须代码拥有。** DiffMem 为此写了 `status.py` 的 `canonicalize_status()`，注释称之为 Model Judgment Boundary violation。对应本仓库 C3 规则。

### 另外两条

- **派生事实无写入生命周期**：aoci-code 明确写了 "None is a Volume or fact source, and none has a write or recovery lifecycle"；Encephalon 的 SQLite 索引是"disposable"的。本 spec 的蒸馏投影同理。
- **预算用字节与条数**：Encephalon 的 `CANONICAL_BUDGETS = { recordBytes: 1 MiB, recordJsonBytes: 8 MiB, records: 1000 }`。

### 冲突裁决

两家都靠模型主动查询，本 spec 的 R1 禁止依赖。裁决：**都要**——层 0/1 自动注入且不依赖深挖；层 2 是可选附加层（模型本来就有 Bash，DiffMem 的检索 agent 用的也是 shell）。

DiffMem 的 token 预算 + 两级优先级与 R3 冲突：裁决为**不采纳 token 截断、采纳优先级标注**，由模型自己选层。

### 未采纳的

Encephalon 把指针写进 `AGENTS.md` 的托管块（可逆移除、1 MiB 上限、原子发布）。本 spec 的层 0 是**派生**的、必须始终新鲜，写进工作区文件会变成需要用户提交的陈旧副本，所以留在系统提示层。

## 环境注意

- 本机 Git Bash 下 `sort` 解析到 `C:\WINDOWS\system32\sort.exe`，POSIX 语义不可用；统计脚本一律用 `awk` 或 Bun。
- `bunx` 会触发重新解析并改写 `bun.lock`（把 `apps/kimi-code` 从 2.3.3 拉到 2.4.0）。已 `git checkout -- bun.lock` 还原。实施中不要引入依赖变更。
- `raw.githubusercontent.com` 在本机不通（无代理）；`api.github.com` 通，git clone 通。

## 待清理

外部实现克隆在 `.tmp/refs/`（`diffmem`、`gcc`、`aoci-code`、`mex`、`encephalon`），测量脚本曾在 `.tmp/memprobe/`。两者都是 gitignore 的临时目录，交付前删除。


## 引用核验记录（2026-10-31 第四轮）

用户提供了三条引用。逐条核验结果如下，**引用本身对结论的影响大于我原来的转述**。

### CommitDistill — 真实（arXiv:2605.18284v1）

核验方式：GitHub 代码搜索定位到 arXiv 论文存档，读取摘要原文。

| 论文里的数字 | 原文含义 |
| --- | --- |
| 确定性正则、无 LLM、无 embedding | 与本 spec 的 D8/D9 一致 |
| Facts / Skills / Patterns 三类知识单元 | 与本 spec 的"类型化产物"一致 |
| TF-IDF 检索器 + 弃权阈值 θ=2.5 | **本 spec 新增 R16（弃权）的来源** |
| 10,000 提交 < 4 秒 | 与本 spec 的"窗口扫描 1.1s"同量级，无冲突 |
| 25,000 提交 → 1,167 单元（4.7%） | 说明大部分提交产不出知识——支持"只取高信号" |
| 检索命中 0.750 @256 字符（BM25 0.333，grep 0.083） | 证明紧预算下密集蒸馏远胜 grep |
| **有用比例 0.525（κ=0.633）** | **警告**：近一半蒸馏单元人工判定无用 |
| **n=200 修 bug 对照：主指标无统计可检测提升** | **决定性**：检索命中不等于任务变好 |

→ 落到 spec：R16（弃权）、R17（不得以命中率当价值证据）、T14、T15。

### Pydantic AI #9150「Git History as Compressed Context」——真实提案，含一处失真引用

核验方式：GitHub issue 搜索拿到全文（2026-03-21 提出，assignee 为维护者 mpfaffenberger）。

设计可用：独立 context 流、独立缓存与 token 计量、`GitContext`/`CommitSummary` 数据形状、`before_model_request` 刷新钩子、pi-mono 的文件操作跟踪。

**失真处**：issue 称 Aider 首创了 git 历史压缩上下文，并引用 `aider/repo.py` 的 `get_commit_hashes` 与 `aider/chat_chunks.py` 的 Git ChatChunk。逐行核对 aider 源码：

| issue 的说法 | 实测 |
| --- | --- |
| `get_commit_hashes` 存在 | **不存在**（`get_rel_repo_dir` 存在，`repo.py:320`） |
| `chat_chunks.py` 有 Git ChatChunk | `ChatChunks.repo` 是 repo map（文件树+签名） |
| Aider 注入 git 历史进 prompt | **全库无一处 `git log`** |

Aider 真正的贡献是**分块上下文架构 + 每块独立 cache 控制**。→ 这反而澄清了一件事：**"独立缓存"是架构能力，与内容是否来自 git 无关**。本 spec 的落地方式是"层 0 只依赖 HEAD ⇒ 同 HEAD 下逐字相同 ⇒ 跨会话命中 cache"，不需要新协议。

### Structured Contextual Distillation（SCD）——查不到（**第五轮已更正**）

GitHub 代码搜索零结果；WebSearch 返回完全无关内容。**不采信其任何数字**，只采纳与我们已有性质重合的部分：逐字节可复现（R18 / T16）。我们本来就没有生成式步骤，锁死即可。

### 方法论教训

三条引用里：一条真实但含失真引用、一条真实且含决定性负结果、一条无法验证。**"听起来对"与"读过源码"之间隔着具体行号。** 因此新增 R19：外部结论一律分级标注（读过源码 / 只读转述 / 无法验证）。


## SCD 核验记录（第五轮）

用户提供了本地 PDF：`C:\Users\Administrator\Downloads\SCD_v31_Academic_Paper.pdf`。此前记为"查不到"，**此处更正**。

**提取方式**：本模型无 PDF 输入能力（Read 工具拒绝），改为用 Bun 解压 PDF 内容流 + 抽取文本算子，得到 68,758 字符；MacRoman 连字（`ﬁ`/`ﬂ`/`ﬃ`/`ﬄ`）需手工映射回 ASCII（否则是 `Þ`/`ß`/`¢`/`£`）。修掉孤立代理字符后文件才是合法 UTF-8。

**论文本体**（已读全文）：

> **SCD v3.1: A Deterministic, Vendor-Independent Protocol for Persistent, Verifiable Agent State**
> Paul Desai, ActiveMirrorOS Research, Goa, India · 2025-12 · "Universal Passport Edition"
> 自述状态："Production-Validated (N=1005 + Cross-Vendor + Adversarial Defense)"

要点：把 agent 状态搬到文件系统（External）；RFC 8785 JSON 规范化（Canonical）；turn-based 版本号（Deterministic）；**宪法锁**（Governed）；SHA-256 完整性链（Tamper-Evident）；跨厂商可携带（Vendor-Independent）。

**验证范围要看清**：§6.1 环境为 Mac Mini M4 / macOS 15 / Gemini 3 Pro / Claude 4.5 Opus；§6.2 Tier 1 是**逐个协议操作隔离测试**（初始化、带校验读取、turn 递增、宪法锁强制、规范化下的校验和、原子 supersession）。**"1005 次转换 100% 确定性"指的是协议函数字节一致，不是 agent 任务效果**——与 CommitDistill 的教训同构。

**自陈局限（§9.1）**：单 agent 串行假设；**不支持分支历史**（明说 VCS 的分支历史需要 Merkle 树）；无语义查询；治理需手工配置；规模未验证（状态 KB 级）。

**自陈非目标（§3.4）**：不替代 RAG / 语义检索 / 关系模型。

### 对本 spec 的影响

**最重要的一条（R20）**：SCD §3.3 论证"提示词是建议性的、可被绕过"，而我们的注入载荷里装着 **commit subject——任何人都能写进仓库的文本**。原 spec 把它原样注入系统提示与工具结果，等于自己开了一条提示注入通道。现有 `<git-context>` 只注入 3 条（`gitContext.ts:60`），本 spec 会注入更多条 ⇒ 必须按不可信数据处理（净化 + 截断 + 数据标记 + 不写祈使句）。

**R22**：注入文本不得写"你必须……"这类祈使句——价值应来自信息在场，而非模型服从一句不可验证的指令。

**R21**：不透传原始浮点数（比例按固定小数位），否则逐字节可复现（R18）无法成立。

**反向确认**：SCD 的目标是"可编辑、可版本化、可跨厂商携带的 agent 状态"；我们的目标是"不可编辑、可重算的投影"。**两者不是同一件事**——这印证了把"写入型记忆"移出本 spec 范围的决定。

### 三条引用的最终核验状态

| 引用 | 状态 | 关键内容 |
| --- | --- | --- |
| CommitDistill | 真实（arXiv:2605.18284v1） | 检索 0.750 vs BM25 0.333 vs grep 0.083；**但 n=200 修 bug 对照主指标无提升**；有用比例 0.525；弃权 θ=2.5 |
| Pydantic AI #9150 | 真实提案，**Aider 引用失真** | Aider 全库无 `git log`；其真实贡献是分块上下文 + 每块独立 cache 控制 |
| SCD v3.1 | **真实**（此前误记为查不到） | 确定性协议；治理在协议层不在提示层；**100% 确定性指协议函数，非任务效果** |


## 实施过程中的偏离记录

（实施时发现设计有误、因而改掉的地方。设计结论改了就在这里记，不回头改已确认的结论。）

### 偏离 1 — 共变相似度公式：加权式 → 提交成员集上的余弦（T2）

**原设计**：`w(pair) = 1/C(n,2)`（每提交总权重 1，平摊到文件对），`score = w(x,y)/sqrt(w(x)·w(y))`。

**为什么不行**：写 T2 的测试时算出这个分值**随提交规模漂移**：

| 场景 | score |
| --- | --- |
| 两个文件永远一起出现在 2 文件提交里 | **2.0**（>1） |
| 两个文件永远一起出现在 10 文件提交里 | **0.222** |

也就是说**最强的信号（永远同行）恰恰因为提交较大而被 0.8 门槛滤掉**，而门槛本身还随仓库的典型提交规模漂移——换个仓库就得重新标定。

**改成**：成员集上的余弦 `score = |A_x ∩ A_y| / sqrt(|A_x|·|A_y|)`，永远同行恒为 1.0，与规模无关。

**代价核算**：换公式后在同一操作点重测，结论几乎不变——

| 指标 | 旧加权式（weight≥1, score≥0.5） | 新余弦式（count≥5, score≥0.5） |
| --- | --- | --- |
| precision | 0.407 | 0.407 |
| recall | 0.150 | 0.149 |
| 平均提出 | 3.1 | 3.1 |
| 有提示的提交 | 58.5% | 58.5% |

所以之前基于旧公式的实测结论**仍然成立**，只是门槛不再需要按仓库重新标定。

### 偏离 2 — 不变量阈值：`count ≥ 50` → `count ≥ 5 且 score ≥ 0.9` + 取前 12

**原设计**：`count ≥ 50` 的共变对算不变量。**问题**：那个数是在**完整 1500 提交窗口**上测的，而实现看到的是剔除"仅 1 文件"与">30 文件"提交后的子集——在训练段里最高的共变对只有 **32 次**，`count ≥ 50` 会得到 **0 条**不变量，功能等于不存在。

**改成**：`count ≥ 5 且 score ≥ 0.9`，按 count 降序取前 12。实测本仓库正好 12 对，头部全是双语文档/i18n 对（`i18n/locales/en.ts ↔ zh.ts` score 1.000）。

**教训**：**阈值必须对着实现真正看到的数据标定**，不是对着某个一次性统计窗口。

### 偏离 3 — 去团块改用"排除机械提交"，不再靠加权摊薄

余弦公式本身**不能**消除团块假象——实测排除前每文件伙伴数 max 仍是 **50**（`_base/lifecycle/disposer.ts` 等），因为那 50 个伙伴全来自 oxfmt 与去注释两个仓库级提交。

**改成**：触碰文件数 > 25 的提交**不参与共变统计**（与 R4 的"病态提交只报摘要"同一门槛），但仍进 change-group。排除 281/1500 个提交后：每文件伙伴数 max 降到 **5**、mean 0.05、96.7% 的文件没有伙伴，不变量 12 对。**排除提交比任何加权公式都更直接地解决团块问题**——因为假象的成因就是那几个提交。

### 实施期发现并已写入计划的两个工程细节

1. **`FlagId` 就是 `string`**，不是品牌类型——flag id 拼错不会在编译期报错，只能靠测试兜住。
2. **flag 注册依赖 `src/index.ts` 的副作用 `import`**，不是自动的。漏一行 = flag 永远不生效且无任何报错。
