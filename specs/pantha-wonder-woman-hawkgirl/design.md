# 设计方案（完整范围）

## 分层前提

先固定"什么放哪里"，后面每条需求都按它落点。以下结论均由代码核对得出，不是偏好。

| 层 | 承载 | 依据 |
| --- | --- | --- |
| `packages/kosong` | 纯线上协议：请求/响应的字段名与编码 | `modelFamily.ts:41-46` 明写 "Wire encoding … belongs to the protocol bases in `human/llm/requester/bases` and to the provider wire contract in `@moonshot-ai/kosong`"。kosong 内没有任何家族概念（`capability-registry.ts` 只认 OpenAI/Anthropic/Gemini 前缀） |
| `llm-adapter/provider/provider-definition.ts` | provider 作用域的事实：端点、凭据环境变量、能力函数、错误分类 | `:53` 的 `trait` 与 `:56` 的 `capability` 都挂在 definition 上，按 provider id 注册（`:65-79`） |
| `human/llm/modelFamily.ts` | 模型家族作用域的事实：计价、prompt 形态、思考历史、家族判据 | 现有 `imagePricing` / `thinkingHistory` / `reasoningEffort` 三项即此层先例 |
| `human/llm/requester/bases/openai/requester.ts` | 需要同时看到"家族 + 请求形态"的决策 | 该函数已有三处家族特判：`:100-107`、`:112-115`、`:135-138` |
| `Trait` | **不承载家族行为** | `trait` 挂在 provider id 上。`:207-211` 的 `openai` definition **没有 trait**，只有 `:225-256` 的 `kimi` 有。用户把自建 DeepSeek 端点配成 `[providers.workbuddy] type = "openai_legacy"` 时命中的是 `openai` 那条，trait 为 `undefined` |

**由此得到三条硬结论：**

1. 家族行为不能放 trait——它在用户自建 provider 上根本不会被调用。
2. 家族行为不能放 kosong——那层不该认识 `deepseek` 这个字符串。
3. 需要"家族 + 请求形态"联合判断的，放 `prepareOpenAIRequest`；纯 provider 事实放 provider definition；纯家族常量放家族表。

---

## D1 思考档位默认 `max_tokens`（对应 R1）

**做法**

1. `ModelFamilyProfile` 增加冻结的 `maxOutputDefaults?: { nonThinking; thinking; thinkingMaxEffort }`，DeepSeek 条目填 `8192 / 65536 / 131072`。
2. 在 `prepareOpenAIRequest` 的 cap 计算处（`requester.ts:119-123`）追加**第四层兜底**：

   ```ts
   const sentinel = requested !== undefined && requested <= 0;
   const cap = sentinel
     ? undefined
     : (resolveMaxCompletionCap(input)
       ?? trait?.completionTokensWhenUnset?.(input)
       ?? familyDefaultCap(input));
   ```

   优先级：显式值 > provider trait > 家族档位。`familyDefaultCap` 读家族表、按 `input.thinking?.effort` 选档、与 `input.model.maxContextSize - usedContextTokens` 取 min、`Math.max(1, …)` 兜底、最后仍受 `CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING` 约束（该约束在 `openai-legacy.ts:741-752` 已存在，无需重复实现）。

3. **哨兵必须显式短路**。`:120-123` 的 `<= 0 → undefined` 是"不限制"的语义，但它随即落进 `??` 右侧；若不加 `sentinel` 短路，配置 `max_completion_tokens = 0` 的 DeepSeek 用户会静默变成 `max_tokens: 8192`。这是本设计里唯一会伤到现有用户的地方。

**为什么放 requester 而不是 trait**：见"分层前提"第 1 条。`kimiUnsetCompletionTokens`（`llm-kimi/trait.ts:69-77`）能工作，是因为 Kimi 有专属 provider definition；DeepSeek 没有，且不该要求用户把 provider 改名为 `deepseek` 才能获得正确上限。

**为什么不放 `completion-budget.ts`**：该文件（`llm-adapter/model/completion-budget.ts`）的入参只有 `maxOutputSize` 与 `maxCompletionTokensCap`，拿不到思考档位；要让它拿到，需要把 thinking 一路穿透 `llm-adapter`，改动面远大于收益。

---

## D2 token 估算的权威与基线（对应 R2）

**做法**

1. 在 `agent-core-v2` 侧新增单一出口 `countPromptTokens(messages, pricing?)`，**prompt 预算与 compaction 一律走它**。若现有调用点已经收敛到单个函数，则它就是该出口的别名，不新增间接层。
2. 基线测试对 `countPromptTokens` 断言，因此"被断言的函数"与"预算实际用的函数"是同一个，不可能漂移。
3. `packages/kosong/src/tokens.ts` 单独建基线，阈值独立。**两者阈值不共享**：kosong 版对 JSON 内容乘 1.3（`estimateTokensForJson`），`agent-core-v2` 版不乘（`estimateTokens` 是纯 ASCII/4 + 非 ASCII 1），同一 JSON 语料两者天然相差约 23%，共用 ±15% 在数学上不可能同时成立。
4. 断言按语料类别分组：`ascii-code`、`cjk-prose`、`json-args` 各自一条。这样任一分支持被改动都会命中对应断言，阈值具备承载力——不依赖"总量占比恰好够大"这种偶然。

**为什么先定权威再建基线**：否则可能给一段没人调用的代码锁死数字。用单一出口让"权威"成为结构事实，而不是文档承诺。

---

## D3 抑制 `response_format`（对应 R3）

**做法**：抑制点在 `requester.ts:131` 的 `extraParams` 合并**之后**，与 `stripIgnoredSamplingParams`（`:135-138`）同位置：

```ts
kwargs = shake(assign(kwargs, input.extraParams?.openai ?? {}));
if (suppressResponseFormat(input)) {
  const { response_format: _dropped, ...rest } = kwargs;
  kwargs = rest;
}
```

`suppressResponseFormat` 为真当且仅当：`input.tools.length > 0` 且 `resolveModelFamily(input.model.model)` 命中 DeepSeek 家族。

**为什么不能放 `:116-117`**：`:131` 会把 `extraParams.openai.response_format` 合并回来。在 117 处跳过只是让"我们设的那个"消失，调用方仍可通过 extraParams 送达。

**为什么删掉"日志只出现一次"**：`prepareOpenAIRequest(input, options?)` 的 options 只有 `{ trait?, reasoningKey? }`（`:77-80`），没有 logger。要在此处记录日志必须引入模块级状态，会污染测试。改为：抑制是纯函数行为，由请求体断言验收。

---

## D4 provider 定义与 wire 触发器（对应 R4）

**做法**

1. `registerProviderDefinition({ id: 'deepseek', baseProtocol: 'openai', endpoint: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrlEnv: 'DEEPSEEK_BASE_URL', defaultBaseUrl: 'https://api.deepseek.com' }, capability, classifyError })`，形态对照 `:44-48` 的 `kimiEndpoint` 与 `:219-223` 的 `google-genai`。
2. **不注册 `openai_responses` 变体**：本规格不覆盖 Responses 格式的家族行为（见 D3 的范围限定），注册一个不生效的 definition 会误导。
3. `capability(modelName)` 返回 `thinking: true`、`tool_use: true`、`image_in` 按 V4.1 能力、`max_context_tokens` 取家族常量，避免落到 `UNKNOWN_CAPABILITY`。
4. **用户配置优先**：若用户已定义 `[providers.deepseek]`，注册不得覆盖（`registerProviderDefinition` 在重复注册时抛 `BugIndicatingError`，这里需先 `hasProviderDefinition` 判定）。
5. **wire 触发器写进文档而非代码**，判据三条：
   - DeepInfer 或第三方发布**非 OpenAI 兼容**的 HTTP 服务；
   - `so_args` 的 `ebnf` / `json_schema` 需要**独立于 `response_format`** 的字段表达（当前 recipe 能把它映射到 `response_format`，故不成立）；
   - 出现客户端**必须读取的私有响应字段**（如 SWA 窗口元信息、草稿接受率），`usage` 无法承载。

   三条全不成立时不新增 wire——新增 wire 是对不存在协议的适配。

**为什么 provider 定义仍要做**：R1/R3 的家族行为虽然不依赖 provider 定义，但用户手写 `[providers.xxx] type = "openai_legacy"` 会丢失能力声明与错误分类，落到 `UNKNOWN_CAPABILITY`；同时 provider 定义是"这个端点是什么"的唯一可观测声明点。

---

## D5 真实 tokenizer 的接缝与降级（对应 R5）

**核心约束**：`prepareOpenAIRequest` 与预算路径是**同步**的，而 sidecar / HTTP 后端天然是**异步**的。把异步计数器塞进同步调用点是不可能的。

**做法：两层分离**

1. **Tier A（同步，请求前）**：`TokenCounter` 同步接口，实现为 `heuristic` 或 `wasm`。预算与 compaction 只用这一层，行为可预测。
2. **Tier B（异步，响应后 / 离线）**：`sidecar` 与 `http` 后端只用于离线校准与夹具生成，不进热路径。它们产出的真实 `prompt_tokens` 反过来校准 Tier A 的系数或阈值。
3. 计数结果携带 `source: 'heuristic' | 'wasm' | 'sidecar' | 'http'`，回退到启发式时 `source` 必须反映事实。禁止静默返回 0 或抛错。
4. 三种后端实现同一接口，构造失败（二进制缺失、WASM 加载失败、端口不通）时**降级到下一档**并保留 `source`。

**为什么不做成"一个 async 接口到处 await"**：预算判定在同步路径上，改造成异步会波及每个调用方，且让 compaction 的时序变得不可控。

**为什么首选 wasm**：仓库是 Bun + TS，WASM 无外部进程、无跨平台进程管理差异（Windows 上 sidecar 的 stdin/stdout 语义与 Unix 不同，是已知坑）。

---

## D6 SWA 尾部重锚定（对应 R6）

**事实**：`DEEPINFER_YOCO_PREFILL_KEEP_TOKENS=140` 是**解码端重放的有界后缀**，且 README 要求该后缀覆盖 SWA 窗口加最大回溯长度。因此解码时超出该后缀的上下文不被重新读取。客户端看不见窗口，只能决定"什么放在尾部"。

**做法**

1. 纯判定函数：`shouldReanchorTail({ estimatedTokens, threshold, lastAnchorTokens })`。返回布尔，无副作用，可穷举测试。
2. 需要重锚定时，通过 reminder 机制注入紧凑"任务契约"（目标 + 硬约束），注入点位于上下文尾部。
3. 幂等沿用现有判据：`DeepseekAdaptationService.resolve`（`deepseekAdaptationService.ts:76-87`）先查 `injection.lastInjection`，存在且非空则返回 `undefined`。新变体照此实现。
4. 阈值是可配置常量，默认值标注"未经端点测量"；真实窗口确认后只改常量。

**为什么不做成"截断早期消息"**：截断会破坏缓存前缀，且丢信息不可逆。重锚定是加法，最坏情况是多花几十 token。

**为什么不用现有 `deepseek_adaptation` 变体**：那个变体是**一次性**的家族引导（`lastInjection` 非空即不再注入），而尾部重锚定需要在上下文增长后**再次**触发，生命周期不同。

---

## D7 确定性档位（对应 R7）

**做法**

1. 新增正交档位 `determinism`。开启时：请求携带整数 `seed`，并尝试 `temperature: 0`。
2. `seed` 默认由"模型名 + 首条用户消息"的稳定哈希派生（同一会话稳定，跨会话可复现），可被显式配置覆盖。
3. **与思考档位的交互必须写明**：DeepSeek 家族声明了 `ignoredWhileThinking: ['temperature', 'presence_penalty', 'frequency_penalty']`（`modelFamily.ts:88-92`），而 `stripIgnoredSamplingParams`（`requester.ts:135-138`）会在思考时把它们删掉。因此**思考模式下 `temperature: 0` 会被丢弃，`seed` 保留**。这意味着思考模式的确定性完全依赖 `seed` 与服务端 `DEEPINFER_BATCH_INVARIANT=1`，客户端无法单方面保证。
4. 服务端 env 清单写进规格正文：`DEEPINFER_BATCH_INVARIANT=1`、`DEEPINFER_ENABLE_MTP_VARLEN=0`、固定 `seq_seed`。客户端只保证"请求表达了意图"。
5. 不模拟推测解码的任何效果。

**为什么不把确定性塞进思考档位**：两者是正交维度（可以"思考且确定性"，也可以"不思考且确定性"），合并会让参数组合爆炸且无法分别断言。

---

## D8 家族识别的网关兜底（对应 R8）

**现状**：`normalizeModelName` 取最后一个 `/` 之后（`modelFamily.ts:108-111`），再前缀匹配（`:113-127`），最长前缀优先。

**缺口**：`vendor/deepseek-proxy/foo` 的 tail 是 `foo`，不命中。

**做法**：tail 不命中时，按 `/` 切段，逐段判断"该段是否以家族前缀开头"。最长前缀优先与大小写不敏感保持不变。

- `vendor/deepseek-proxy/foo` → 段 `deepseek-proxy` 命中 ✓
- `my-deepseek-clone` → 单段且**不以** `deepseek` 开头 → 不命中 ✓（反向用例保持）
- `xopdeepseekv32` → 仍由单段前缀命中 ✓

**为什么用"段首匹配"而不是"包含匹配"**：包含匹配会让 `my-deepseek-clone`、`not-deepseek-at-all` 误命中，把 DeepSeek 的档位与提示词套到别的模型上，属于不可接受的误伤。

**为什么 `curated/deepseek.md` 的改动也算需求**：AGENTS.md 明确"prompt text is behavior"。V4.1 的工具调用由服务端约束生成，客户端不再需要 JSON 修复兜底；长上下文下以尾部契约为准。这两条改变模型的实际行为，必须作为需求交付并断言渲染结果。

---

## 被否决的方案（保留历史判断，并标注完整范围下的结论）

| 方案 | 原判断 | 完整范围下的结论 |
| --- | --- | --- |
| 新增 `deepinfer` wire type | 否决：无 HTTP server，端点不存在 | **部分推翻，改为条件化**。R4 保留 wire 触发器，三条判据全部成立时才进入评估；不成立时仍否决 |
| 在 kosong 里按模型名硬编码 DeepSeek 分支 | 否决：绕开家族表，把厂商知识放进 wire 层 | **仍然成立**。D1/D3 均落在 requester base，kosong 保持厂商无关 |
| 直接把 deepseek-recipe tokenizer 接进来 | 否决：跨语言依赖成本高 | **推翻**。R5 纳入范围，但拆成同步/异步两层，且以接口 + fake 实现先行落地 |
| 在 `completion-budget.ts` 里做档位选择 | 否决：拿不到思考状态 | **仍然成立**。D1 放 requester base |
| 用 `tool_choice: 'none'` 规避 tool-call 约束 | 否决：改变模型行为 | **仍然成立**。D3 只抑制无效字段，不干预工具选择 |
| 新增 DeepSeek 专属 `OpenAITrait`（本规格上一稿的 D1） | — | **推翻**。`trait` 按 provider id 注册（`provider-definition.ts:53`、`:207-211`），用户自建 provider 命中的是无 trait 的 `openai` 定义，实现不会被调用 |
| 在 `requester.ts:116-117` 抑制 `response_format`（上一稿的 D3 落点） | — | **推翻**。`:131` 的 `extraParams` 合并会把它带回来，抑制点必须后移 |

---

## 风险

1. **哨兵回归（最高）**：`<= 0` 表示"不限制"，若 D1 不显式短路，配置 `0` 的用户会静默获得 8192 上限。验收必须在 R1 里单列一条。
2. **档位上限等于硬上限**：131072 恰等于 `CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING`（`openai-legacy.ts:72`），意味着 max effort 档位在任何情况下都不会被该上限截断——这层保护对该档位是名义上的。需在文档中说明，避免误以为有兜底。
3. **思考模式丢弃 `temperature`**：D7 的 `temperature: 0` 在思考模式下会被 `stripIgnoredSamplingParams` 删除，确定性只剩 `seed`。这属于家族既有语义，不改，但必须写进 R7 并在断言中体现（思考模式下断言 `temperature` 不存在、`seed` 存在）。
4. **两个估算器不等价**：D2 用分组阈值规避，但若未来有人给 `agent-core-v2` 版补上 ×1.3，两条基线会同时移动。夹具需标注该假设。
5. **provider 重复注册**：`registerProviderDefinition` 重复注册直接抛错（`:73-77`）。D4 必须先 `hasProviderDefinition('deepseek')` 判定，否则任何已配置该 id 的用户会在启动时崩溃。
6. **Windows 上的 sidecar**：进程管理语义与 Unix 不同。D5 首选 wasm 即为此；sidecar 只进 Tier B，不进热路径，降低平台风险面。
7. **家族匹配放宽的误伤**：D8 用段首匹配约束，但 `deepseek-proxy` 这类网段仍会命中——这是期望行为（它确实是 DeepSeek 转发）。反向用例必须进测试。
8. **R6 阈值未经测量**：默认常量是保守估计。若真实窗口远大于默认阈值，重锚定会过于频繁，浪费 token。缓解：阈值可配置，且注入内容固定为紧凑契约（数十 token 量级）。

---

## 交付边界

- 本规格覆盖 `openai`（chat completions）基类。`openai-responses` 基类存在同形接缝（`requester/bases/openai-responses/requester.ts:92` 同样调用 `completionTokensWhenUnset`），本规格**明确不覆盖**它，理由是一个决定而非待办：若两条基类各写一份家族档位与抑制逻辑，就会形成两套必须同步维护的家族特判，而 deepseek-recipe 对 Responses 的约束选择与 Chat Completions 分开处理，两份实现必然漂移。该决定的后果由断言固定：T4 #5 要求 `getProviderDefinition('deepseek', 'openai_responses')` 为 `undefined`，因此不会出现"注册了但行为不生效"的定义。
- 由此产生的**已知限制**（记录在案，不是未决事项）：按 `openai_responses` 协议配置 DeepSeek 的用户不会获得 R1 与 R3 的行为，也不会有告警。这是本期明确的取舍；若该取舍的代价变得不可接受，正确的做法是把家族档位与抑制逻辑提到两条基类共享的模块，而不是在 Responses 基类里再抄一份。
