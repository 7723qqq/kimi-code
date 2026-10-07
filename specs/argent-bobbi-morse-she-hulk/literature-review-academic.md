# 文献核对（第三批）：学术文献

**日期**: 2026-10-07
**方法**: 经 arXiv API（`export.arxiv.org/api/query`）检索并核验；**每篇均确认 `id` 可解析、页面返回
HTTP 200 后才引用**。此前我编造过一次 arXiv 编号，本批起该步骤为强制项。

## 本批要回答的问题

前两批读的是实现规范（vLLM、OpenTelemetry）。它们描述**服务端**如何定义指标，对"客户端测量"
只有间接结论。本批查学术界是否研究过**客户端侧测量偏差**，即我在
`reliability-assessment.md` 中列为"不可消除"的那一类。

## 一、直接命中：客户端并发的测量偏差

**arXiv:2605.24217** — *Identifying and Mitigating Systemic Measurement Bias in Production LLM
Inference Benchmarks*（Chandrasekar & Kramberger，2026-05，cs.AI/cs.DC）
<https://arxiv.org/abs/2605.24217>（已核验 HTTP 200）

摘要原文（摘录）：

> we demonstrate that widely used benchmarking utilities rely on single-process, asyncio-driven
> architectures that introduce fundamental **client-side queuing bottlenecks** under high
> concurrency. By modeling the benchmarking client as an $M/G/1$ queue, we mathematically
> demonstrate how the Python GIL **artificially inflates Time to First Token (TTFT) and Time Per
> Output Token (TPOT) metrics** as request rates scale.

**这直接证实并强化了我的结论**：客户端测量会被客户端自身的排队/调度污染。该文把客户端建模为
$M/G/1$ 队列并给出数学论证。

**但必须说清边界**：该文研究的是**基准测试客户端在高并发下**的偏差（GIL、asyncio、单进程），
而**不是**我说的"响应被缓冲后投递"。两者同属"客户端测量不可信"这一大类，但**机制不同**：
- 该文：客户端自己处理不过来 → 测量值**偏高**（延迟被客户端放大）
- 我：服务端先产完再投递 → 测量值**偏高**（速率被交付速度取代）

**共同的结论是同一个**：客户端观测到的 TPOT/ITL **不等于**服务端真实的解码性能。这正是我实现里
那条"客户端只能测观测值"的边界，现在有了学术文献支持。

该文还提出用 NTPOT（Normalized TPOT）来摊薄端到端延迟，与我的问题不直接相关。

## 二、TTFT/TPOT 作为标准术语的出处

**arXiv:2401.09670** — *DistServe: Disaggregating Prefill and Decoding for Goodput-optimized
Large Language Model Serving*（2024-01，cs.DC）<https://arxiv.org/abs/2401.09670>

> LLM applications often emphasize individual latency for each phase: **time to first token (TTFT)**
> for the prefill phase and **time per output token (TPOT)** of each request for the decoding phase.

这是 TTFT/TPOT 成为该领域标准术语的代表性工作之一。**注意其中没有把 TPOT 换算成 tokens/s**——
学术界用的是**每 token 耗时**，不是速率。

**这印证了前两批的发现**：我实现的"tok/s"是把标准指标**取倒数**后的展示形式。取倒数本身无损，
但会让"分母该是 n 还是 n−1"这个选择变得显眼——**而标准定义的 TPOT 分母是 n−1**（vLLM 与
OTel server 均如此），倒数的分子因此是 n−1。

## 三、对本项目结论的影响

### 得到支持（现在有学术文献 + 两份规范）

| 结论 | 依据 |
| --- | --- |
| 客户端测得的 TPOT/ITL 不等于服务端解码性能 | arXiv:2605.24217（数学论证 + 实证） |
| 该偏差是**系统性**的，不是噪声 | 同上，"systemic measurement bias" |
| TPOT 是标准指标，且是"每 token 耗时"而非速率 | arXiv:2401.09670；vLLM；OTel server |

### 需要修正/收窄

| 我的说法 | 修正 |
| --- | --- |
| 我把"缓冲后投递导致偏高"称为**主要**的客户端测量风险 | 学术文献更关注**客户端自身排队**（GIL/asyncio），在高并发下这是更普遍的偏差源。我的场景（单会话、低并发）不触发它，**但我不该把"缓冲后投递"当作客户端偏差的唯一形态**。 |
| 我说客户端偏差"不可消除" | 该文的做法是**换测量架构**（多进程、分摊客户端负载），而不是修公式。**这提示我：如果将来要在客户端做高精度测量，出路是减少客户端自身对测量的干扰，而非改分母。** 对当前单会话 footer 场景不适用，但该结论应记录。 |

## 四、仍未读

- TGI / Triton 的指标文档（`github.com` 直连与本机 HF 站点均不可达；仅能经 GitHub API，
  但代码搜索对 TGI 未命中 `time_per_token`）
- 该文的全文（我只读了摘要与元数据，**未读正文的实验细节**）
- 更早的 TPOT 起源工作（如 Orca、vLLM 论文）——未检索

## 五、诚实声明

- 本批**只读了摘要与元数据**，**没有读任何论文正文**。所有引用均限定在摘要明确陈述的范围。
- 检索工具 `WebSearch` 在本环境下返回无关结果（一次返回足球俱乐部），**本轮所有检索改用
  arXiv API 完成**。
- 我**没有**验证这两篇论文的同行评审状态（arXiv 预印本不等于已发表）。

## 六、补充检索：第三个术语 TBT

**arXiv:2502.11417** — *DiSCo: Device-Server Collaborative LLM-Based Text Streaming Services*
（2025-02，cs.LG/cs.DC）<https://arxiv.org/abs/2502.11417>

摘要明确使用 **Time-Between-Token (TBT)**：

> meeting **Time-To-First-Token (TTFT)** and **Time-Between-Token (TBT)** requirements for
> real-time interactions

**术语现状汇总**（三批文献的净结果）：

| 术语 | 出处 | 定义 |
| --- | --- | --- |
| TTFT | DistServe、vLLM、OTel | 请求到首个 token/chunk |
| TPOT | DistServe、vLLM、OTel server | `(e2e − TTFT) / (输出 token 数 − 1)` |
| ITL | vLLM | 相邻两次流式输出之间的间隔 |
| TBT | DiSCo | 相邻 token 之间的时间 |
| TPOC | OTel client | 相邻 **chunk** 之间的时间 |

**五个术语，没有一个是"tokens/s"。** 全部是"每单位耗时"。这不再是偶然：**该领域的标准做法是度量
延迟，速率是消费端自行取倒数后的展示形式**——正是本模块在做的事。

**DiSCo 对本项目还有一处旁证**：摘要把 "last-hop issues (e.g., Internet latency and dynamics)"
列为服务端部署的痛点。这就是我在上表 D 记录的"缓冲/交付污染测量"在学术界被承认的位置——
它被当作 **QoE 问题**处理（改进交付），而**不是**被当作可以从客户端修正的测量误差。

### 本轮仍未找到

- 任何把 `tokens/s` 作为**被定义指标**的规范或论文
- 对"多 token chunk 下速率失真幅度"的量化研究（我列为未量化的那条）
