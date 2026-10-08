# 外部资料调研 — prompt-optimizer 优化方案

调研目的：为 `scripts/prompt-optimizer` 的缺陷找权威依据与改进方案。结论都附来源，
并标明哪些是"权威建议"、哪些是我在本仓库实测的推论。

## 一、评估方法论：正则匹配为什么不够

### 权威结论

**LLM-as-a-judge 是被系统研究过的方法，且有已知偏差。** Zheng et al. 的 MT-Bench 论文
明确指出 LLM 评判者存在 **position bias（位置偏差）、verbosity bias（冗长偏差）、
self-enhancement bias（自我增强偏差）**，并提出缓解手段；同时给出关键数据：强模型评判者
（GPT-4）与人类偏好的一致率 **超过 80%**，达到"人与人之间"的一致水平。
来源：[Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)（NeurIPS 2023）

**如何构建可靠的评判系统已有专门综述**，覆盖一致性、偏差缓解、场景适配，以及"如何评估评判者本身"。
来源：[A Survey on LLM-as-a-Judge](https://arxiv.org/abs/2411.15594)

**工程侧的标准做法**是把"确定性断言"与"模型评分断言"分层使用：
- 确定性断言：`equals` / `contains` / `regex` / `is-json` / `javascript` / `python`，
  以及 **`word-count`、`rouge-n`、`bleu`、`gleu`、`levenshtein`、`perplexity`** 等
- 模型评分断言：`llm-rubric`、`g-eval`、`model-graded-closedqa`、`factuality`、
  `answer-relevance`、`context-faithfulness`
来源：[Assertions and Metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/)、
[Deterministic Metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/)、
[Model-graded metrics](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/)

### 对本模块的意义

本模块自研了 9 种 evaluator（`contains` / `not-contains` / `tool-called` / `output-length` /
`regex-match` / `json-schema` / `llm-judge` 等），其中：

- **`llm-judge` 声明了但恒返回 0**。资料显示 `llm-rubric` 是成熟且可实现的方案，
  有明确的 JSON 契约（`{reason, score: 0.0-1.0, pass}`）与 `threshold` 语义。
  本模块不必自研，但若保留该类型，应参照该契约实现，而不是恒判失败。
- **`output-length` 应改用 `word-count` 语义**。资料中的 `word-count` 支持
  `{min, max}` 区间，比本模块按行数打分更贴合"约束类"评估。
- **`json-schema` 的修法已符合该方向**（我在上轮改为真正校验 `type`/`required`/`properties`，
  并对未实现的 keyword 返回 0 而非静默通过），与"确定性断言应真正判定"的原则一致。

### 一个关键的坑（资料中明确警示）

`llm-rubric` 的 PASS/FAIL 语义有个常见误用：**未设 `threshold` 时，只要 grader 没有显式返回
`pass: false`，即使 `score: 0` 也算通过**。资料专门用"❌ Problem / ✅ Option A / ✅ Option B"
标注了这个陷阱。

这直接对应本模块的一个设计缺陷：`runAllEvaluators` 用 `score < 1.0` 判定 violation
（`evaluators.ts:64`），**没有独立的 pass 通道**。也就是说本模块把 pass 与 score 耦合了，
恰好与 `llm-rubric` 的推荐模型相反。若要实现 `llm-judge`，这个结构需要先想清楚。

## 二、统计：A/B 检验的数据模型错了

### 权威结论

**样本量必须事先固定，不能"看到显著就停"。** Evan Miller 的经典分析给出量化后果：
在真实无差异的情况下，若每观察一次就检验并提前停止，报称 5% 显著性时**实际错误率可达 26.1%**；
"偷看"次数与所需报告阈值的关系是：

| 偷看次数 | 要达到真实 5% 显著，报告值需低至 |
| --- | --- |
| 1 | 2.9% |
| 2 | 2.2% |
| 5 | 1.4% |
| 10 | 1.0% |

并给出事前的样本量估算式：`n = 16·σ²/δ²`（δ 为欲检出的最小效应，σ² 为预期方差）。
来源：[How Not To Run an A/B Test](https://www.evanmiller.org/how-not-to-run-an-ab-test.html)

### 对本模块的意义（含我实测的量化）

本模块的 A/B 对**同一批用例**跑两个变体（`ab-test.ts:32` 的 `cases` 被两个 variant 复用），
这是**配对数据**，但 `isSignificant` 用的是**非配对置换检验**（把两组混洗再切分）。

我做了量化模拟，用「每用例共享难度 + 变体带来一致小幅提升」的模型（贴近真实：
同一份 prompt 的同一道题，两个变体的表现高度相关）：

| 每用例相关度 | 变体真实提升 | 非配对检出率 | 配对检出率 |
| --- | --- | --- | --- |
| 0.8 | +25% 通过率 | 0% | 2% |
| 0.8 | +40% 通过率 | 2% | 6% |
| 0.9 | +25% | 0% | 0% |
| 0.9 | +40% | 0% | 0% |

改用连续分数（与 `ruleCompliance` 一致）后，差距更极端：

| 真实提升 | n=35 | 非配对检出率 | 配对检出率 |
| --- | --- | --- | --- |
| +0.05 | 35 | **0%** | **100%** |
| +0.10 | 35 | 100% | 100% |

用 `n = 16σ²/δ²` 核算：σ≈0.15、δ=0.05 时需要 **144 个用例/组**，而实际只有 35。
所以 "+0.05 提升检不出" 是数学必然，不是我的模拟假象。

**结论**：当前实现不只是"功效偏低"，而是在 `n=35` 下对小幅改进**完全失明**。
配对检验可以把这部分信号恢复出来。

## 三、方差缩减：一个可选的进阶方向

CUPED（Controlled-experiment Using Pre-Experiment Data）用实验前数据构造协变量来降低指标方差，
从而在不增加样本量的前提下提高显著性检出能力，是微软、Google、Meta 等公司的标准实践。
来源：[CUPED Explained](https://www.statsig.com/blog/cuped)

**对本模块的意义**：本模块天然有"实验前数据"——同一个用例在 baseline 变体上的得分。
这正是配对检验所利用的信息，因此**修好配对已经拿回了 CUPED 的主要收益**，不必额外引入 CUPED。

## 四、对照后的优先级（含来源依据）

| 优先级 | 项 | 依据 |
| --- | --- | --- |
| P0 | `ab` 的两个变体实际相同 | 本仓库实测：两变体均 6423 字节，字节级一致 |
| P0 | `probe` 的 scorer 测的不是行为 | 资料一致强调"确定性断言要真正判定"；实测 `negation-compliance` 最高只扣 0.75、`/^(Sure\|…)/` 锚定行首漏判 |
| P0 | adaptations 数字无来源，却会进系统提示词 | 本仓库实测：无任何代码写 `model-adaptations/` |
| P1 | A/B 改用配对检验 | Evan Miller 的样本量公式 + 我的模拟（n=35 对 +0.05 检出率 0%→100%） |
| P1 | `--experiment` 被忽略、未知参数不报错 | 实测 |
| P2 | `llm-judge` 要么实现要么移除 | `llm-rubric` 契约明确可实现；恒返回 0 是最差状态 |
| P2 | 事前固定样本量并报告可检出效应 | 资料：报告 `δ = (t_{α/2}+t_β)σ√(2/n)` 而非"当前显著性" |
| P3 | `src/knowledge/` 去留、纳入类型检查 | 需决策 |

## 五、我没有找到权威依据的部分

- **`priority-reasoning` 该怎么测**：这是本模块自定义的维度，业界无对应标准。
  资料只提供了通用原则（区分"确定性"与"模型评判"）。**它到底该测"遵从 harness 的
  system-reminder 优先级"还是别的目标，必须由产品语义决定**，我不能从网上找到答案。
  已知的约束是：产品 `system.md:27` 规定 `<system-reminder>` 为权威指令，而该 probe 的
  systemPrompt 却写了相反的规则——**这个矛盾需要产品侧拍板**。
- **adaptations 里那批数字（0.91 / 0.89 / +22%）的真实来源**：无代码生成它们，
  我无法从外部资料推断其出处，只能确认它们**没有任何可追溯的产生过程**。
