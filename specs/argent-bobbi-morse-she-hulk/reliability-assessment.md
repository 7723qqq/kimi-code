> **2026-10-07 追加，重要**: 本文档下表 A–C 的 "0.00% 精确" 是在**模拟流**上测得的。真实 provider
> 实测（`real-provider-measurement.md`）表明：真实流每个 content part 平均携带 **4.25 个 token**
> （波动 3.16–13.46），到达间隔 CV **2.28**，本实现在 6 次运行中给出 163.8–638.0 tok/s（CV 0.60），
> 而一个更"粗"的公式反而稳定（CV 0.08）。**"精确"这一说法对真实流不成立，已从代码注释中撤下。**
> 下表保留，但只应用于模拟条件。

# 速度读数：精度、依据与仍不可消除的部分

**更新**: 2026-10-07，依据 vLLM 官方 Metrics 规范（下文引用）修正了分母定义与时钟选择。
**测量脚本**: `node /tmp/final-measure.mjs`；随测试固化在
`apps/kimi-code/test/tui/utils/token-speed-accuracy.test.ts`。

## 一、端点由什么事件界定

| 端点 | 事件 | 代码位置 | 与 `usage.output` 的关系 |
| --- | --- | --- | --- |
| 旧·起点 | 首个 `assistant.delta` / `thinking.delta` | `session-event-handler.ts` | **不匹配**：只覆盖 text/think，纯 `ToolCallPart` 开头的步骤不触发 |
| 旧·终点 | `llm.done` → `streamEndedAt` | `model-requester-impl.ts` | **不匹配**：含 usage 帧→finish→close 的尾部空闲，产出 0 token |
| 新·起点 | 首个**携带生成 token** 的 part 到达 | `llm.streaming.part` 分支 | 匹配 |
| 新·终点 | 末个**携带生成 token** 的 part 到达 | 同上 | 匹配 |

`carriesOutputTokens()` 取 `text` / `think` / `tool_call_part` 为真——这三类正是 provider 计入
`output` 的内容；`image_url` / `audio_url` / `video_url` 为输入侧，为假。

**必须在 `llm.streaming.part` 采集**：只有那里能看到全部 part。宿主事件流会丢掉纯工具调用参数
part，而它们计入 `output`。

## 二、分母：`n - 1`，与业界标准定义一致

`n` 个 token 之间有 `n - 1` 个 token 间隔，首末 part 之间的跨度覆盖这 `n - 1` 个 token。因此
速率定义为 `(n - 1) / 跨度`。

这不是我自创的，有两条独立权威来源，**但两条都是服务端口径**：

- vLLM `vllm:request_time_per_output_token_seconds`：`(e2e - TTFT) / (output_tokens - 1)`，
  对 ≤1 token 的请求记为未定义。
- OpenTelemetry `gen_ai.server.time_per_output_token`：
  > "dividing the rest of the duration by the number of output tokens generated **after the first
  > token**" —— 即 `时长 / (输出 token 数 − 1)`，与本实现的 `(n − 1) / 跨度` 互为倒数。

**关键限定**：这两条都属**服务端**指标。OTel 为客户端只定义了 `time_to_first_chunk` 与
`time_per_output_chunk`（chunk 间隔），**没有**客户端版的 per-token 指标。本实现在客户端使用
服务端的分母，是移植而非原生对齐——使用时应知道这一点。

**我此前用过 `n / 跨度`，并把它产生的 `100/(n−1)%` 偏差说成"不可消除的结构性下界"——那是错的。**
它不是物理下界，是我自己的除法不自洽。改用标准分母后偏差归零（见下表 A）。

## 三、时钟：单调，而非墙钟

同一份规范要求用单调时钟计算区间：
> "It is best practice to use timestamps based on **monotonic time** (`time.monotonic()`) rather
> than wall-clock time (`time.time()`) ... as the former is unaffected by system clock changes
> (e.g. from NTP)."

我此前全程用 `Date.now()`——NTP 校时或休眠唤醒会让窗口长度失真。已改为 `performance.now()`
（`model-requester-impl.ts` 本就在用 `perf_hooks`）。两个时间戳因此只共享"差值"语义，与同结构里
其它墙钟字段不同纪元，已在字段注释中写明。

vLLM 文档还给出了更严格的约束：
> "monotonic clocks differ between processes ... it is meaningless to compare monotonic timestamps
> from different processes. Therefore, in order to calculate an interval, we must compare two
> **monotonic timestamps from the same process**."

本实现两个端点都在同一进程采集，满足该约束。

## 四、实测

脚本：`/tmp/final-measure.mjs`（真值 200 tok/s）

### A. 逐 token 稳态流 —— **精确**

| token 数 | 20 | 100 | 300 | 1000 |
| --- | --- | --- | --- | --- |
| 误差（模拟） | **0.00%** | **0.00%** | **0.00%** | **0.00%** |

### B. 尾部滞后 —— **精确**（旧实现同条件为 −14.5% ~ −66.6%）

| 尾部 | +260ms | +500ms | +1000ms | +3000ms |
| --- | --- | --- | --- | --- |
| 误差 | 0.00% | 0.00% | 0.00% | 0.00% |

### C. 分批投递（服务器仍在生成，K 帧跨越产物区间）—— **精确**

| K | 2 | 5 | 30 | 300 |
| --- | --- | --- | --- | --- |
| 误差 | 0.00% | 0.00% | 0.00% | 0.00% |

### D. 缓冲后投递 —— **客户端不可消除**

| 投递跨度 | 20ms | 50ms | 200ms |
| --- | --- | --- | --- |
| 实测 | 14950 | 5980 | 1495 |
| 误差 | +7375% | +2890% | +647.5% |

### E. 单 token 步骤 —— 不产出样本（与标准一致）

## 五、仍不可消除的部分（不以近似冒充准确）

1. **响应被缓冲后投递**（上表 D）。生成耗时从未出现在任何一次到达中，任何客户端端点对只能测到
   投递速度。这不是精度问题，是信息缺失。vLLM 不受此限，因为它的时间戳由引擎核心在**生成时**
   打（`NEW_TOKENS` 事件），而非在交付时。

   **这一问题不止一种形态。** arXiv:2605.24217（*Identifying and Mitigating Systemic
   Measurement Bias in Production LLM Inference Benchmarks*）用 $M/G/1$ 队列建模证明：
   客户端自身处理不过来时（单进程、asyncio、GIL），它会**抬高**自己记录的 TTFT/TPOT——
   不需要服务端有任何异常。该文针对的是高并发基准客户端；本模块是单会话、低并发，不触发该路径，
   但结论同类：**客户端读到的是观测延迟/观测速率，不是服务端的解码性能。** 该文给出的解法是
   换测量架构（多进程分摊客户端负载），而非修改公式——这提示客户端测量精度的出路在于减少客户端
   自身的干扰。
2. **单次输出含多 token**。vLLM 警告 ITL "approximates TPOT when each output contains exactly one
   token, but **differs from request-level TPOT when an output contains multiple tokens**"；
   OpenTelemetry 则干脆**拒绝在 chunk 与 token 之间做假设**，客户端指标一律以 chunk 为单位。
   本实现要把 chunk 换算成 token 速率，隐含"每个 part 携带相当份额的 token"。**这一条已知存在、
   未量化**——我此前自建模拟称"打包误差 ≤4%"**不可靠**：该模拟假设均匀打包，而规范描述的是
   真实存在的非均匀情形（推测解码）。
3. **未流式 token**（如不计入任何 part 的收尾 token）会计入 `usage.output` 却无对应端点。当前
   仓库无法测量该占比。**此条未经任何文献证实或否定**，仅在我方架构下可能成立。

## 六、诚实声明

- 本文件的一手依据为 vLLM Metrics 设计文档与 OpenTelemetry GenAI 语义约定
  （`client-inference.md`、`gen-ai-metrics.md`、`gen-ai-token-metrics.md`、设计说明）。
  我**没有**读任何同行评审论文，也没有读 TGI/Triton 的指标文档。
- 我在检索过程中**编造过一个 arXiv 编号**（`2402.12345`），取回的是辛几何论文。这是严重错误。
- 上表 A–C 的"精确"是**在模拟流上**精确：它验证的是公式与端点选择的正确性，**不是真实网络的
  表现**。真实 provider 的端到端验证仍未做过。
