# 回退完成：会话累计口径（方案 1）

**日期**: 2026-10-07
**触发**: 真实 provider 实测（`real-provider-measurement.md`）证明"逐步骤速率"在真实流上不可用，
用户选择方案 1（回退到会话累计口径）。

## 一、新口径的定义

```
每步：windowMs = 最后一个携带 token 的 part − 第一个携带 token 的 part
      windowTokens = usage.output − 1        （n 个 token 只有 n−1 个间隔）
累加：decodeMs += windowMs
      decodeTokens += windowTokens
读数：decodeTokens / decodeMs × 1000
```

- **无平滑、无 EMA、无衰减常数**——读数就是累计商。
- **缺任一端的步骤整对跳过**（不把 token 数与时间分开计入，否则比值有偏）。
- **单 token 步骤不贡献**（与 vLLM / OTel 对该情形的"未定义"处理一致）。
- 生命周期：会话切换、`/undo`、replay 时 `reset()`。

## 二、代码改动

| 位置 | 改动 |
| --- | --- |
| `apps/kimi-code/src/tui/utils/token-speed.ts` | 完全重写为 `measureStep` / `accumulateStep` / `tokensPerSecond` / `TokenSpeedSampler`（累计式）；删除 `MIN_SAMPLE_TOKENS=20` 证据下限、`DECAY`、`IMPLAUSIBLE_RATE_CEILING`。当前阈值为 `MIN_SAMPLE_TOKENS = 2`：只有"单 token 无间隔"这一条理由成立，见 `token-speed.test.ts` 的单 token 用例 |
| 字段重命名（第二轮） | `llmFirstTokenAtMs` → `llmFirstTokenOffsetMs`，`llmLastTokenAtMs` → `llmLastTokenOffsetMs`；基准由 `performance.now()` 改为 `Date.now() − performance.now()` 的常量偏移加 `performance.now()`，差值不变但绝对值进入 epoch 域，跨进程（transcript 落盘 / WS 协议 / web）才可用。同时新增 `llmWindowOnFrameClock`，供消费方把窗口端点与帧时间戳做同源校验 |
| 删除死字段 | `ModelRequestTiming.firstPartAtMs` / `usageAtMs`（早期版本遗留，已无消费方） |
| `kimi-tui.ts` | `noteStepCacheStats(usage, {llmFirstTokenOffsetMs, llmLastTokenOffsetMs})`，调用 `addStep`；删除 `noteStepBegin`（累计式无需丢弃未关闭窗口） |
| `session-event-handler.ts` | 删除 `noteStepBegin` 声明与调用；`noteStepCacheStats` 传新字段 |
| Web（`sessionStats.ts`） | 同步使用新字段名，并对声明了 `llmWindowOnFrameClock` 的帧校验窗口与帧时间戳是否同源；分子统一为 `output − 1`，与 TUI 的 `windowTokens` 一致 |

## 三、真实 provider 复核（`deepseek-v4-pro` via `ollama.com`）

6 次运行：

| | 均值 | 范围 | 变异系数 |
| --- | --- | --- | --- |
| 逐步骤（被替换） | 165.5 | **35.5 – 321.1** | **0.663** |
| 累计（新） | 167.3 | **95.7 – 321.1** | **0.445** |

**必须诚实说明两点：**

1. **累计口径的 CV 会随运行次数自然下降**（它本身是滑动平均）。所以上表两列不完全可比——
   真正该看的是"用户在某一时刻会看到的值散布有多大"：新口径 95.7–321.1，旧口径
   35.5–321.1。新口径消除了**下限方向的极端值**（35.5 → 95.7），这是真实的改善：突发导致的
   极低速值不再出现。
2. **上限仍然到 321**：因为首末 part 跨度在突发时依然会压缩，单步仍可能虚高。累计只把它摊到
   整段历史里，**没有消除它**。

**结论：回退改善了底部噪声，没有消除顶部噪声。** 这与"大分母更稳健"的预期一致，但不能说
问题已解决。

## 四、验证

| 检查 | 结果 |
| --- | --- |
| 全仓 `typecheck` | 通过，无 error |
| `kimi-code` 全量 | 18157 passed / 1 failed（见下） |
| `token-speed.test.ts` | 19 tests，全部重写为累计契约 |
| `kimi-tui-message-flow.test.ts` | 297 passed（5 个速度用例重写） |
| Web / 其他包 | 见最终报告 |

唯一失败：`agent-core-v2/.../workspaceInstructions/instructions.test.ts`——**单独运行 7/7 通过**，
是文件监听类测试在跨包并行下的偶发失败，本文件未改动。

### 四之二、精度实测（MiniMax-M2，2026-10-07）

脚本：`measure-minimax.cjs`（主测量）、`probe-ineff.mjs`、`probe-window-anatomy.mjs`、
`probe-tail-inference.mjs`。走 MiniMax 的 Anthropic 兼容流式端点，每个 `content_block_delta`
记到达时刻，只把 text/thinking 这类真正计入 `output_tokens` 的 part 当端点。

基准是**客户端可观测真值**：provider 上报的 `output_tokens` 除以整段流式跨度（含尾部空转）。
这是客户端能拿到的诚实上限，不是服务端内部解码时间。

| 回复规模 | 样本数 | 中位误差 | 最大误差 | ±5% 内 |
| --- | --- | --- | --- | --- |
| 900 token | 12 | **+0.63%** | 0.89% | 12/12 |
| 500 token | 6 | +1.42% | 1.86% | 6/6 |
| 300 token | 8 | +2.18% | 2.46% | 8/8 |
| 120 token | 3 | +7.6% | 9.5% | 0/3 |
| 24 token | 8 | **+31.0%** | 40.5% | 0/8 |

**误差是一阶可解释的，不是随机噪声。** 该端点每约 25 个 token 才发一个 part（间隔
310–510 ms）；窗口的首尾各被批次间隔量化一次，而被量化掉的正是解码真正发生的两段，因此读数
系统地**偏高**，量级约为 `batchInterval / window`——实测比值与此吻合（900 token 时
meanGap/window = 3.0–3.6%，300 token 时 8.3–9.1%，24 token 时 50–100%）。

**试过并否掉的改进**：把窗口末端延长一个批次间隔，以覆盖被丢掉的尾部
（`probe-tail-inference.mjs`）。

| 回复规模 | 现行口径 | 尾部延续 |
| --- | --- | --- |
| 900 token | +0.7% | −2.2% |
| 300 token | +2.0% | −5.8% |
| 120 token | +8.1% | −16.5% |
| 24 token | +28.9% | **−35.5%** |

每一档都更差：它把同量级的低估换成了同量级的高估，净收益为负，因此**不采纳**。

**未能触发的情形**：12 次长样本全部是逐块流式交付，没有一次出现"服务端先攒完再吐"；该情形在
`token-speed-accuracy.test.ts` 里记录为 +647% ~ +7375% 的误差，本次未复现，**不代表真实环境
已经安全**。

**端点侧调参无效**：`thinking: disabled`、`top_p`、`temperature`、`stream_options` 都不改变
part 粒度（仍是约 25 token/part），说明这是服务端行为，客户端无法通过参数修复。

## 五、仍未解决 / 未验证

- **顶部突发未消除**（上文第二点）。若要求彻底稳定，需要放弃"从到达时刻推断速率"。
- 只测了 `ollama.com` 转发的 `deepseek-v4-pro`；官方 `api.deepseek.com` 余额不足。
- 样本 6 次，CV 估计本身有误差。
- 仍未在真实 provider 上验证**思考型输出**（该端点 `reasoning_tokens` 恒为 0）。

## 六、此前被撤回的说法

- "模拟流上 0.00% 精确" → 仅对模拟流成立，真实流不成立，已从代码与报告中撤下。
- "本实现优于 MiMo Code / deepseek-harness" → 真实数据不支持，已撤回。
