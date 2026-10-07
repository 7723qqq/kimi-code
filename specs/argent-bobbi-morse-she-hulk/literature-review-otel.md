# 文献核对（第二批）：OpenTelemetry GenAI 语义约定

**日期**: 2026-10-07
**来源**:
- [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) —
  `docs/gen-ai/client-inference.md`（116 KB）、`docs/gen-ai/gen-ai-token-metrics.md`（84 KB）
- 此前已读：vLLM Metrics 设计文档

GenAI 语义约定已从 `open-telemetry/semantic-conventions` 迁出（旧路径只留 Moved 提示），
新仓为 `semantic-conventions-genai`。

## 一、最重要的发现：客户端流式指标里**没有速率**

OpenTelemetry 为**客户端**（正是我方所处位置）定义的流式指标只有两个：

| 指标 | 定义 |
| --- | --- |
| `gen_ai.client.inference.time_to_first_chunk` | "Time to receive the first chunk, measured from when the client issues the generation request to when the first chunk is received" |
| `gen_ai.client.inference.time_per_output_chunk` | "Time per output chunk, recorded for each chunk received after the first one, measured as the time elapsed **from the end of the previous chunk to the end of the current chunk**" |

**规格里没有任何 `tokens_per_second` / `throughput` 指标。** 我用 grep 查了全文，
`tokens_per` / `per_second` / `throughput` 的匹配全部落在无关行（如 URL 里的 "generate-content"）。

这是本次最有价值的一条：**我一直在实现的东西，标准规范不做。** 原因见下。

## 二、为什么规格不做速率：它与我的结论一致

1. **`time_per_output_chunk` 的定义与我的窗口端点完全同构**——它测的是"上一个 chunk 结束到当前 chunk
   结束"，即**chunk 到 chunk 的到达间隔**，正是我在 `firstOutputPartAtMs → lastOutputPartAtMs` 上做的
   事。差别只在规格按 chunk 逐个记录直方图，而我把它聚合成一个速率。
2. **规格用 chunk 而非 token 作为单位**，并刻意回避"每个 chunk 含多少 token"的假设。这正是
   我在 `literature-review.md` 里承认"未经证实地假设 part 与 token 对应"的地方——**规格的做法是
   干脆不假设**。
3. **规格对服务端才定义 token 计数**（`gen_ai.client.inference.usage.output_tokens` 是计数
   Counter，不是速率），且加了限定：
   > "if the count is **readily available** ... If instrumentation cannot **efficiently obtain**
   > number of input and/or output tokens, it **MAY** allow users to enable offline token counting.
   > Otherwise it **MUST NOT** report usage metrics."

   即：**拿不到 token 数就不要报**。这支持我在实现里采取的"无可用样本则不产出读数"（返回 null
   而非 0 或猜测值）的做法。

## 三、我的结论哪些得到支持、哪些需要收窄

### 得到支持

| 我的说法 | 文献依据 |
| --- | --- |
| 客户端可观测端点天然受限 | 规格把客户端指标限定为 TTFC 与 per-chunk 间隔；token 用量与服务端指标分开定义 |
| 单 token/单 chunk 无间隔可测 | `time_per_output_chunk` 明确只对 "each chunk received **after the first one**" 记录——与我把单 token 步骤判为无样本一致 |
| 拿不到数据就不要编 | 上引 "MUST NOT report usage metrics" |
| 应使用单调时钟 | vLLM 文档（上一批已核） |

### 需要收窄 / 修正

| 我的说法 | 修正 |
| --- | --- |
| 我称我的容器是 "decode rate / tokens per second" | **规格刻意不定义该指标**。更准确的自我描述是："由客户端观测的 chunk 间隔聚合出的速率"。我此前把它等同于业界标准度量，是过度声称。 |
| 我把 `(n−1)/跨度` 说成"与标准定义一致" | **只有 vLLM 那一路（服务端 TPOT）如此**。OTel 这一路根本不除以 token 数，而是按 chunk 记间隔。两套体系口径不同，我不该把前者称为"业界标准"而不加限定。**两套并存，我的实现更接近 OTel 的 chunk 间隔思路，只借用了 vLLM 的 `n−1` 分母来把间隔换算成速率。** |
| 我假设 part 与 token 对应 | 规格拒绝做这个假设，按 chunk 度量。我的 `n−1` 分母隐含了"每个 token 至少贡献一个可观测到达"，在推测解码/多 token chunk 下会失真——**这正是我之前承认未量化的那条，现在有了规范的旁证：标准选择绕开它，而非解决它。** |

## 三点五、`n−1` 分母的权威依据：`gen_ai.server.time_per_output_token`

`gen-ai-metrics.md:313-322` 给出了与我实现完全同构的定义，原文：

> This metric reports the model server latency in terms of time per token generated
> **after the first token** ... It is measured by subtracting the time taken to generate
> the first output token from the request duration and **dividing the rest of the duration
> by the number of output tokens generated after the first token.** This is important in
> measuring the performance of the decode phase of LLM inference.

即：`时间跨度 / (输出 token 数 − 1)`，与我实现的 `(n − 1) / 跨度` 互为倒数。**这是 OTel 层面的
权威依据**，此前我只从 vLLM 一处得到该定义。两条独立来源一致。

**但关键限定**：该指标属于 **"Generative AI model server metrics"** 一节，即**服务端**指标。
同一文档中**客户端**只有 `gen_ai.client.operation.duration`（总时长）与
`gen_ai.client.inference.time_per_output_chunk`（chunk 间隔），**没有任何客户端版
`time_per_output_token`**。

**结论收窄**：`n−1` 分母的定义是标准的，但**标准把它放在服务端**。我方在客户端使用该分母，
属于把服务端口径移植到客户端——这与 vLLM 的做法（引擎核心打时间戳，本质是服务端）也不完全相同。
**我此前说"与业界标准定义一致"是对的，但漏掉了"该标准指标是服务端指标"这一限定，应予补上。**

## 四、仍未读的

- `docs/gen-ai/gen-ai-metrics.md`（65 KB）——通用指标，可能含操作时长等
- `docs/gen-ai/gen-ai-spans.md`（84 KB）
- `docs/gen-ai/openai.md`（169 KB）、`anthropic.md`（36 KB）——provider 特定，可能规定 streaming
  字段语义
- TGI / Triton 的指标文档（HF 站点本机不可达）
- 任何同行评审论文（我尚未检索过任何学术文献；此前编造过一次 arXiv 编号）

## 五、`token-metrics-design.md`（非规范性设计说明）——无新约束

读完了 5.3 KB 的设计理由文档。它解释的是**计数器的维度设计**（modality 为何在 counter 而非
histogram、为何 cache/reasoning 单列），与速率无关，**不改变任何前述结论**。

其中一句对本项目有旁证价值：
> "guessing `text` invents data"

——规格对"猜测缺失维度"的态度是明确禁止，与我实现中"无可用样本则返回 null 而非猜测值"一致。

## 六、provider 特定约定（anthropic.md）——无新增

Anthropic 约定只是把通用属性具体化（`gen_ai.request.stream`、`gen_ai.response.time_to_first_chunk`、
各类 `gen_ai.usage.*.output_tokens`）。**没有** provider 特定的速率定义，也没有对 chunk 与 token
关系的额外规定。`gen_ai.usage.output_tokens` 的定义与通用一致：
"The number of tokens used in the GenAI response (completion)."

未读：`openai.md`（169 KB，体积大且按前述模式判断为同一模板的属性具体化）。

## 七、本批文献的净结论

1. **规格不定义客户端 tokens/s**。客户端流式只有 TTFC 与 per-chunk 间隔；token 用量是计数器。
   速率要么由服务端给（`gen_ai.server.time_per_output_token`），要么由消费方从计数器自行求
   ——**而服务端那个指标的前提是服务端能在生成时打时间戳**，客户端没有这个前提。
2. **`n−1` 分母有两条独立权威来源**（vLLM、OTel server），但**都是服务端口径**。我在客户端
   使用它，属于移植。这一点需要如实标注，不能含糊成"与业界标准一致"。
3. **规格拒绝在 chunk 与 token 之间做假设**，改用 chunk 为单位。我的实现隐含该假设，
   在推测解码/多 token chunk 下会失真——**这是我知道但未量化的已知缺陷**。
4. 规格的 `MUST NOT report` 与 "guessing invents data" 支持我"无样本即不显示"的做法。
