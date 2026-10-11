# 外部资料调研 — 提示词改写（prompt rewriting）的可靠做法

调研目的：为 `packages/agent-core-v2/src/features/promptOptimizer/` 的「扩句」退化找权威依据，
并确定哪些做法可落地。每条标注**一手来源**与**二手转述**，以及是否可验证。

---

## 一、核心机制：单轴压制会把优化压力转移到别的轴

**《Reward Bias Substitution: Single-Axis Bias Mitigations Redirect Optimization Pressure》**
arXiv:2605.27996，2026-05-27，Lamparth / Fein / Haupt / Hussing / Kochenderfer（Stanford）。
一手来源：<https://arxiv.org/abs/2605.27996>

原文摘要的两处关键陈述：

> Single-axis mitigations of reward-model biases (e.g., reducing proxy reliance on length,
> sycophancy, or style) can **rotate optimization pressure onto correlated proxies** rather than
> eliminate it, a failure mode we call **reward bias substitution**.

> We demonstrate bias substitution in language model RLHF, where a **length penalty during GRPO
> training compresses responses as intended yet redirects optimization pressure onto confidence
> calibration, driving the policy into overconfidence while factual free-form accuracy falls.**

以及一个对"如何验证修复"有直接约束的结论：

> successful mitigation, bias substitution, and overcorrection produce **identical observables under
> any audit-distribution scoring**, including ranking accuracy and win-rate, even when granted
> oracle access to the true reward.

处方：**同时追踪多个偏差，并用 policy-induced 分布（而非仅 audit 分布）评估**。

**对本模块的含义。** 当前提示词用三条约束（不许加需求/约束/验收标准/背景；长度贴近原稿；
已清楚就原样返回）压掉了**信息量**这个轴。模型无法在内容上改进，压力转移到**措辞**轴：
输出不再显著变长，但每个词被换成更"正式、完整、专业"的说法。这解释了实测现象——比值降到
1.2 倍，观感却更像"扩句"。

同时它约束了修复方式：**只再压一个轴（例如"不许换词"）是同类错误**。正确做法是提供一个
合法的改进维度（命名真实指代），而不是继续叠加禁令。

**可验证性：** 本仓库实测。同模型 A/B，六个用例、每例 5 轮取中位数，比值 3.62 → 1.20。

---

## 二、Anthropic：提示词的"合适高度"与反对清单式规则

**《Effective Context Engineering for AI Agents》**
Anthropic Applied AI，2025-09-29。一手来源：
<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

原文要点（直接引用）：

> **System prompts** should be extremely clear and use simple, direct language that presents ideas at
> the ***right altitude*** for the agent. The right altitude is the Goldilocks zone between two common
> failure modes. At one extreme, we see engineers **hardcoding complex, brittle logic in their
> prompts** to elicit exact agentic behavior. This approach **creates fragility and increases
> maintenance complexity over time**. At the other extreme, engineers sometimes provide **vague,
> high-level guidance** that fails to give the LLM concrete signals for desired outputs.

> you should be striving for the **minimal set of information that fully outlines your expected
> behavior**. (Note that **minimal does not necessarily mean short**; you still need to give the agent
> sufficient information up front to ensure it adheres to the desired behavior.)

> Providing examples, otherwise known as few-shot prompting, is a well known best practice that we
> continue to strongly advise. However, teams will often **stuff a laundry list of edge cases into a
> prompt** in an attempt to articulate every possible rule the LLM should follow for a particular
> task. **We do not recommend this.** Instead, we recommend working to curate a set of **diverse,
> canonical examples** that effectively portray the expected behavior of the agent. For an LLM,
> **examples are the "pictures" worth a thousand words.**

另有一条与"上下文预算"直接相关的背景概念：

> Studies on needle-in-a-haystack style benchmarking have uncovered the concept of **context rot**:
> as the number of tokens in the context window increases, the model's ability to accurately recall
> information from that context decreases. […] Context, therefore, must be treated as a **finite
> resource with diminishing marginal returns**.

**对本模块的含义。**
- 当前提示词有 11 条 `-` 规则，且在"不许加信息 / 不许变长 / 不许改动"上把行为约束到接近
  硬编码脆弱逻辑那一端 —— 正是原文点名的失败极端。
- "minimal 不等于 short" 说明**单纯删短指令不是正解**；应当减少规则数量、提高每条的信息密度，
  并补 canonical examples。
- "context rot" 支持恢复一个上下文长度预算（见 R5）。

**可验证性：** 属设计原则，不能直接断言收益；落地后需用第七节的测量轴自行验证。

---

## 三、GEPA：当前最强的提示词优化器，两条可直接照搬的工程决策

**《GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning》**
arXiv:2507.19457，2025-07-25。一手来源：<https://arxiv.org/abs/2507.19457>
代码：<https://github.com/gepa-ai/gepa>（已并入 DSPy）

实测（原文摘要）：

> Across six tasks, GEPA **outperforms GRPO by 6% on average and by up to 20%, while using up to 35x
> fewer rollouts**. GEPA also **outperforms the leading prompt optimizer, MIPROv2, by over 10%**
> (e.g., +12% accuracy on AIME-2025).

工程决策（一手来源：DSPy 官方文档 `dspy.GEPA` API 页）：

1. **用文本反馈而非标量分数作为优化信号。** metric 可返回 `{score, feedback}`；原文列举可用
   信号包含**约束违规（constraint violations）**、评测日志、解析失败、错误信息。
2. **超长直接抛错，不截断。** 官方文档对 `InstructionProposer` 的 `max_chars` 参数原文：
   > character limit validated with Pydantic after one compression attempt; an oversized result
   > **raises instead of being returned or truncated**.

   以及 `ReflectionConfiguration`：反思所用的 LM 应当强于被优化的对象。

**对本模块的含义。** 第 2 条直接印证了本仓库的**静默截断回归**：一个 SOTA 优化器面对超长输出
的选择是**报错**，而 `f8f8a27764` 把 `clamp()` 改成 `text.slice()` 并删掉了守住它的测试。
第 1 条为 `scripts/prompt-optimizer` 的评分模型升级提供了方向。

**可验证性：** 第 2 条可立即落地并有明确验收。

---

## 四、改写引入的"正式措辞"会实质损害下游 agent

**《Lost in the Request: How Communication Variation Disrupts Retrieval and Action in Email Agents》**
arXiv:2610.02627，2026-10-02。一手来源：<https://arxiv.org/abs/2610.02627>

原文摘要（直接引用）：

> **Indirect requests reduce performance on all three benchmarks, while formal requests reduce
> performance on both agentic benchmarks.** […] In the agentic setting, indirect and formal requests
> mainly cause the agents to **omit required actions**, not to take more unsupported actions.

**对本模块的含义。** 这条把"扩句"从观感问题变成**实质性损害**：把用户草稿改写成更正式、
更完整的措辞，会让接收到该提示词的下游 agent **漏掉本该执行的动作**。这为"禁止把平实措辞换成
正式措辞"提供了实证依据，而不只是品味偏好。也支持恢复"保留草稿原有用词"这类约束。

**可验证性：** 论文结论针对 email agent 基准；对编码 agent 的外推需标注为**未在本仓库验证**。

---

## 五、其他值得入库的方法（可信度较低或未细读）

| 来源 | 内容 | 可信度 |
| --- | --- | --- |
| arXiv:2502.16923（2025-02-24）<br>A Systematic Survey of Automatic Prompt Optimization | APO 的形式化定义 + **5 部分统一框架**，把相关工作按特征分类。适合作为 `scripts/prompt-optimizer` 方法论对齐的目录 | 一手（仅读摘要） |
| arXiv:2406.07496<br>TextGrad | 把自然语言反馈当"文本梯度"迭代改进；适合需要细致反馈的任务 | 一手（经二手综述转述，未读原文） |
| arXiv:2603.08091（v4 2026-09-29）<br>JudgeBiasBench | LLM judge 偏差的**4 维度 / 12 类型**分类学 + 受控注入流程；可用作 `llm-judge` evaluator 的检查表 | 一手（仅读摘要） |
| arXiv:2608.02919（2026-08-03）<br>FLARE | GEPA 的后续工作，面向 few-shot 场景 | 仅读摘要 |
| PromptHub《A Complete Guide to Meta Prompting》（2025-10-23） | 汇总 APE / LCP / PromptAgent / DSPy / TextGrad 等元提示词方法的对比 | **二手博客** |

**未证实的说法（不要当结论用）：** 有二手博客称"GEPA 用更短、纯指令的提示词就能超过
MIPROv2"。论文摘要**没有**这句，DSPy 文档也未作此声明。仅见于 Medium 博客，标注为未证实。

---

## 六、由调研得出的设计约束（供 `design.md` 引用）

1. **禁止单轴修复**（§1）。修复必须同时提供合法改进维度与多条测量轴。
2. **减少规则数量、提高信息密度，并补 canonical examples**（§2）。单纯删短或单纯加规则都不对。
3. **超长输入与超长输出都必须显式报错或有可见标记，不得静默截断**（§3）。
4. **禁止把平实措辞"提升"为正式措辞**（§4）。
5. **上下文是有限资源**，历史窗口需要长度上界（§2 context rot）。

---

## 七、本仓库已有的实证数据（可作为回归基线）

来源：`~/.kimi-code/sessions/**/agents/*/wire.jsonl`，通过脚本提取每次改写的
`Prompt to rewrite:` 输入与子代理最后一条 assistant 文本。共 153 条可用记录。

### 7.1 改前 / 改后对比

| 口径 | 旧（`agent` profile，截至 10-11 06:17） | 新（`promptOptimizer`，06:47 起） |
| --- | --- | --- |
| 样本 | 108 条 | 4 条（另有 A/B 复现 6 例 × 5 轮） |
| 长度比中位数 | 约 3.6 倍 | 约 1.2 倍 |
| 增量性质 | **可执行细节**：真实文件路径、函数名、符号名、编号工作项 | **措辞**：同义替换为更正式/更完整的说法 |

旧版样例（**这才是用户记忆中的"详细"**）：

- 草稿 `请完整修复后提交`（8 字）→ 1176 字，含 `droppedVars` 误报的具体文件
  `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts`、修复范围 1–4、
  验证命令清单。
- 草稿 `请继续分析如何推进`（9 字）→ 801 字，逐项列出 5 个遗留项及其路径与风险。
- 草稿 `按整体最优方式进行`（9 字）→ 721 字，给出选项 A/B 的取舍并要求"先说清为何整体最优"。

新版样例（**"扩句"**）：

- `请分析如何全部最优方案和最完整方案 减少打补丁和便宜`（26）
  → `请基于上文的 i18n 硬编码审查结论，分析全局最优且最完整的整体治理方案（而非局部修补），并说明如何从根本上减少打补丁式的临时修复和低成本的将就做法。`（76）
- `请完整进行优化`（7）→ `请完整实施上文的 i18n 硬编码整体治理方案、全部落地，而不是只做局部修补或临时兜底。`（44）
- `开始完整推进 需要事后验收 提示词需要专业优质`（23）→ 150 字，扩成三段。

### 7.2 用户草稿未包含的内容被写入改写结果

2026-10-11 07:32，用户以 Ctrl+P 改写草稿
`最重要的问题是现在的提示词会从以前的详细变成现在的扩句一样`（29 字）。

- 产出（48 字）：`最重要的问题是提示词重写的结果：原本详细的内容现在会被改成像扩句一样，请优先查清并修掉这个退化。`
- **`请优先查清并修掉这个退化` 是模型添加的**，草稿中没有。
- 该子代理的 think 轨迹记录了它的推理：
  > This is a user complaint about the prompt optimizer […] a **regression report wanting a fix**.

  即模型把"隐含想要修复"当作授权，自行补入了要求。

### 7.3 子代理在改写期间执行了调查

同一次运行（session `9d79f688`，agent-0，profile `promptOptimizer`）在改写回合内发起
**6 次工具调用、3 个并行批次**（Glob/Grep），读取 `promptOptimizer` 自身源码、
`.changeset/prompt-optimizer-shortcut.md`、`readTool.ts` 等，并把调查结论
（`i18n 硬编码`、`P0–P5`）写进了 07:22–07:26 的改写结果 —— 这些细节来自**会话上下文**，
不来自草稿。

### 7.4 A/B 复现（同模型 `workbuddy/deepseek-v4.1-flash`，Anthropic 端点，每例 5 轮）

| 草稿（字数） | 旧比值中位数 | 新比值中位数 |
| --- | --- | --- |
| `请分析如何全部最优方案和最完整方案 减少打补丁和便宜`（26） | 1.35 | 1.19 |
| `请完整进行优化`（7） | 7.00 | 1.71 |
| `开始完整推进 需要事后验收 提示词需要专业优质`（23） | 2.78 | 1.17 |
| `最重要的问题是现在的提示词会从以前的详细变成现在的扩句一样`（29） | 1.21 | 1.03 |
| `修一下登录那个 bug`（11） | 4.45 | 0.91 |
| `fix the auth thing`（18） | 4.94 | 1.17 |
| **平均** | **3.62** | **1.20** |

同时观察到：旧版会把工作目录路径**凭空塞入**结果
（`Fix the authentication issue in the working directory.`），新版不塞。

**注意：** 上表是「已写入一版修复」后的结果，该版修复在 07:44 被并发的另一个会话覆盖还原，
当前 `promptOptimizer.ts` 处于未修复状态。复现方法见 `tasks.md` 的 T7。
