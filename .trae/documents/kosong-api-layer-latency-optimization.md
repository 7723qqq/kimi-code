# Kosong API 层延迟优化

## Context

`packages/kosong` 是与上游 LLM provider（Anthropic、OpenAI、Google Gemini、Moonshot Kimi）通信的抽象层。当前架构有若干可观测的延迟源，按收益排序本文档列出三组改动，每组都有明确的文件位置、当前成本、和验证手段。

收益估算基于经验值：实测 benchmark 待补充，本文档给出的是改动前的延迟组成 + 改动后预期消除的部分。

## 改动清单

### A. Anthropic cache_control 稳定性 + TTL 可配（小 → 中等收益）

**现状**：
- `packages/kosong/src/providers/anthropic.ts:1033` 每个请求重建 `anthropicTools` 数组，工具顺序/内容变化 → cache miss
- `CACHE_CONTROL = { type: 'ephemeral' }` 硬编码（5 分钟 TTL）
- 长 session（100k+ tokens）下，每次 cache miss 都按全量 input token 计费 + 多等几百 ms

**目标**：
- 工具数组在 Provider 实例上 memoize，key 为 `(name, JSON.stringify(parameters))` 的 hash + 顺序稳定
- 加 `cache_control.ttl` 配置（默认 `ephemeral`，可选 `5m` / `1h`）
- 与 `withGenerationKwargs` 配合：`tools` 变化时失效缓存

**收益**：长 session TTFT 从 ~2-3s 砍到 ~200-500ms（cache hit 时）

**风险**：
- 如果调用方动态修改 tool schema 而我们缓存了旧版 → cache miss 但不影响正确性（只是慢了）
- TTL 拉长意味着 server 端 cache 占用增加，需要文档说明 tradeoff

### B. 显式 undici Agent + keep-alive（小改动，大收益）

**现状**：
- 4 个 provider SDK（anthropic/openai/openai-legacy/google-genai）都委托给默认 `globalThis.fetch`
- 默认 undici Agent：50 idle conns、5s connect timeout、无显式 keep-alive tuning
- CLI 短进程（启动 → 几次 LLM 调用 → 退出）的冷启动每次新 TCP+TLS（50-150ms）

**目标**：
- 新建 `packages/kosong/src/http/undici-agent.ts`，导出 `createSharedAgent()` 单例
- 配置 `Agent({ keepAliveTimeout: 60_000, pipelining: 1, connections: 64, connectTimeout: 10_000, headersTimeout: 30_000 })`
- 通过各 SDK 的 `httpClient` 选项（或 `dispatcher` for `fetch`）注入
- Agent 在进程内共享，避免每个 Provider 实例重建

**收益**：每个 session 首调用省 50-150ms；高 QPS 场景下连接复用更明显

**风险**：
- 跨 provider 共享一个 Agent 不会跨域（每个 origin 一个 pool），安全
- 但要注意：Agent 创建后立即打开 0 个连接（lazy），所以初始化无开销

### C. OpenAI Responses 工具参数流式去 O(n²)（小改动，明显收益）

**现状**：
- `packages/kosong/src/providers/openai-responses.ts:776` 用 `+` 拼接每个 delta：
  ```ts
  setFunctionCallArguments(
    streamIndex,
    getFunctionCallArguments(streamIndex) + argumentsPart,  // O(n) per delta
  );
  ```
- N 个 delta 累积成 N² 次 string copy + 分配
- 另外 `yieldFinalArgumentsSuffix`（L781-820）把完整参数从 server 端再发一遍，浪费字节 + CPU

**目标**：
- 工具参数改为数组累积：`argsByIndex.set(streamIndex, [...current, argumentsPart])`
- 最终 emit 时一次性 join（也只 join 一次）
- `yieldFinalArgumentsSuffix` 仅在最终参数与累积 prefix 不一致时触发（fallback）；如果完整参数还没收到，继续等待

**收益**：大工具调用（>1KB 的 URL、shell command）省 50-500ms CPU + GC

**风险**：
- 如果下游消费方期望 string 流（不是 array），需要适配
- 当前消费方在 `agent-core` 内，下游按 string 用，我们 join 后还是 string，无破坏性变更

## 不在本次范围

按 ROI 排序，下列改动明确**不**做：

| 改动 | 原因 |
|---|---|
| Hedged requests | 大改 retry 语义，需要单独的 design doc + 充分测试 |
| Google Vertex cachedContent | 需要 provider 选项设计，超出 API 层抽象 |
| 移除 `structuredClone` 默认行为 | consumer 不确定是否需要 clone，激进改动风险高 |
| 微任务批处理 text delta | 收益 5-20ms 太小，不值得引入新 bug |
| OAuth client LRU | 收益 1-5ms，且 OAuth 路径用得少 |
| OpenAI `prompt_cache_key` | 需要约定 session identity 派生规则 |
| 关掉 SDK 内部 retry | 风险高（破坏长上下文流的重试），收益不确定 |
| `prompt_cache_key` for Kimi | 已经有类型支持，但需要约定派生 |

后续如果这三组上线后实测显著，再考虑扩展。

## 实施步骤

按 A、B、C 顺序：

1. **B 优先**：独立最小，先建立 undici-agent 单例 + 注入各 SDK
2. **C 其次**：纯函数改造 + 单测
3. **A 最后**：涉及 Provider 实例状态管理，需要最小心

每步完成后跑：
- `pnpm typecheck`（kosong + 应用）
- `pnpm vitest run packages/kosong`（库单测）
- 必要时 `pnpm vitest run packages/agent-core`（下游 consumer）

## 验证策略

每组改动单独 commit + 单独 review。回滚成本低。

没有引入新依赖。改动量估算：

| 改动 | 新文件 | 修改文件 | LOC 估算 |
|---|---|---|---|
| A | 0 | 1（anthropic.ts + 测试） | 80-120 |
| B | 1（undici-agent.ts） | 4（provider 适配点） + 测试 | 60-100 |
| C | 0 | 1（openai-responses.ts）+ 测试 | 30-60 |

总计 ~200-280 行改动。
