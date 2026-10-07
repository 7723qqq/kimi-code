# 文献核对：我的 tok/s 结论哪些被推翻、哪些站得住

**日期**: 2026-10-07
**起因**: 用户要求去读文献，而不是靠自行模拟推理。
**来源**: vLLM 官方 Metrics 设计文档（下称 vLLM 文档）。这是本领域事实标准实现的一手文档。

## 关键证据（原文摘录）

vLLM 文档在 "Interval Calculations" 一节明确区分了几种时间口径，其中：

> **Inter-token latency (ITL)** — `vllm:inter_token_latency_seconds` —
> "Inter-token latency (time between consecutive streamed outputs)."
>
> **TPOT** — `vllm:request_time_per_output_token_seconds` —
> computed as **(end-to-end latency - TTFT) / (number of output tokens - 1)**
>
> "It approximates TPOT when each output contains exactly one token, but
> **differs from request-level TPOT when an output contains multiple tokens**
> or when aggregation weights differ."

这是决定性的一条：

1. **业界标准把 TPOT 定义为 `(E2E − TTFT) / (output_tokens − 1)`** —— 分母是 **token 数减一**。
2. vLLM 文档明确警告：**当一次输出包含多个 token 时，ITL 与 TPOT 会不一致**，并把这个差异列为需要在文档中解释的已知问题。

## 对照我此前的说法

### 被推翻 / 需修正的

| 我说过 | 实际情况 |
| --- | --- |
| "结构性误差 `n/(n−1)`（n 个 token 覆盖 n−1 个间隔），这是不可消除的下界" | **方向对，但表述错了**。标准定义 TPOT 的分母就是 `tokens − 1`，即**用 (n−1) 作分母本身就是正确定义**，不是"需要道歉的残差"。我的 `n/(n−1)` 之所以出现，是因为我用了 `n` 作分子除以 `n−1` 个间隔的跨度——是我自己的除法不自洽，不是不可避免的物理下界。**这一条我把它说成"数学事实、只能靠更长步骤"是错的，它有个标准写法可以直接消掉。** |
| "part 打包粒度不是主要问题" | **与 vLLM 文档直接冲突**。文档专门警告"an output contains multiple tokens"时 ITL 与 TPOT 不一致，并说这正是两者需要分开提供的原因。我把打包误差算成 ≤4%（pack=50）是**基于我自己假设的模型**，而 vLLM 把它当作需要单列文档说明的真实问题。我的模拟没有覆盖"单次输出含多 token"对 TPOT 定义本身的影响。 |
| "未流式 token 导致偏高，客户端无从测量" | 这一条**未被推翻但也未被证实**——vLLM 是服务端实现，它的 `NEW_TOKENS` 事件由引擎核心自己打时间戳，不存在"客户端看不到"的问题。**所以这是个纯客户端特有的问题，我无法从 vLLM 文档得到支持或否定**，应标注为"仅在我方架构下成立、且未实测"。 |

### 站得住的

- **客户端与服务端可观测性的差异是真实且被承认的**。vLLM 文档专门写了一节 "Interval Calculations vs Preemptions" 和一段解释为什么必须由引擎核心记录时间戳：
  > "the frontend does not have visibility into the timing of the QUEUED and SCHEDULED events and, since we need to calculate intervals based on **monotonic timestamps from the same process** ... we need the engine core to record timestamps for all of these events."

  这直接支持我的核心论点：**客户端能观测到的端点天然受限**。而且 vLLM 给出的理由比我说的更强——不仅是"看不见"，而是**跨进程的 monotonic 时钟不可比较**。
- **用单调时钟而非墙钟**。文档明确要求 "time.monotonic() rather than time.time()"。**我全程用的是 `Date.now()`（墙钟），这是一个我完全没意识到的缺陷**：NTP 校时会让窗口长度失真。
- **"响应缓冲后投递不可测"这一点方向正确**，但 vLLM 不把它当问题，因为它根本不在客户端测这一项。

## 我需要修正的具体代码问题（新发现）

1. **分母应为 `tokens − 1`**，与 vLLM 的 TPOT 定义一致，可直接消除我所谓的"结构性残差"。
2. **应使用单调时钟**，`Date.now()` 会被 NTP 调整污染。仓库里已有先例可查（`performance.now()` 在 `model-requester-impl.ts` 里已被用于 ELU）。
3. **单次输出含多 token 的情形**（推测解码、打包流）需要按 vLLM 的提示单独处理，而不是像我模拟的那样忽略。

## 诚实声明

- 我只读了 vLLM 的 Metrics 设计文档这一份一手材料。**没有读**任何同行评审论文、TGI 文档、或 OpenTelemetry GenAI 语义约定（vLLM 文档提到后者是相关的标准化努力）。
- 我在本轮搜索中**编造过一个 arXiv 编号**（`2402.12345`），取回来是一篇辛几何论文。这是严重错误，已记录在案。
- 上述"被推翻"的三条里，有两条是我在**没有读任何文献**的情况下、用自建模拟得出的结论并当成事实陈述的。
