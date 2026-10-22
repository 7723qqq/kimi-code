# DeepSeek-V4.1-Flash 客户端适配（DeepInfer 生态，完整范围）

## 背景

DeepSeek 于 2026-10-20 开源内部推理框架 **DeepInfer**（Apache-2.0，基于 vLLM 派生），同步开源编解码组件 **deepseek-recipe**。以下事实来自两侧 README 与本地仓库代码，是本规格的全部事实基础：

**DeepInfer 侧**

- 只支持 `DeepSeek-V4.1-Flash`（默认 checkpoint `-1017`）。
- 本次只放出**离线推理**（Python 入口 `examples/offline_inference.py`）。README 明确列出"不在本次发布内"的三项：KV cache 系统、VE/Prefill/Decode 分离部署、DP 副本间负载均衡。
- 内置能力：DSpark 推测解码 + confidence-scheduled verification（`DEEPINFER_ENABLE_MTP_VARLEN`、`DEEPINFER_USE_NEXTN_DECODE`）、解码端 SWA bounded replay（`DEEPINFER_YOCO_PREFILL_TRUNCATION_MODE=compact`、`DEEPINFER_YOCO_PREFILL_KEEP_TOKENS=140`）、batch-invariant 推理（`DEEPINFER_BATCH_INVARIANT=1`）、确定性采样（`seq_seed`）、结构化输出（`so_args` 的 regex / json_schema / ebnf）。
- 硬件：NVIDIA SM100、华为昇腾 950。

**deepseek-recipe 侧**

- Rust 库 + Python bindings，职责是把 Messages / Chat Completions / Responses 三种请求格式统一转成 Conversation，渲染成 V4/V4.1 prompt，编码成 token ID，并把模型输出转回对应响应格式。
- 带官方 tokenizer；`ConversationRequest::resolve_max_tokens` 定义三档默认输出上限：非思考 8192、思考 65536、思考 + max effort 131072。
- 约束选择规则：请求带 tools 且 `tool_choice` 不是 `none` 时，`OutputConstraint` 取 **tool-call block 语法**；否则取 `response_format` 的 JSON / JSON Schema / regex。
- 附带 `server-rs`（Axum）与 `server-py`（FastAPI）两个 **mock 推理**的示例服务。

**本地仓库侧**（已核对到行）

- `human/llm/modelFamily.ts` 已有 `deepseek` 家族（前缀 `deepseek` / `xopdeepseek`），其图像计价常量是拿 `workbuddy/deepseek-v4.1-flash` 实测校准的——正是 DeepInfer 唯一支持的模型。
- `requester/bases/openai/requester.ts` 已在该函数内做三处家族特判：思考历史兜底（`:100-107`）、`fullReasoningEchoRequired`（`:112-115`）、`stripIgnoredSamplingParams`（`:135-138`）。
- `provider-definition.ts:53` 把 `trait` 挂在 **provider definition** 上，按 provider id 注册；只有 `kimi` 的三条 definition 挂了 trait（`:225-256`），`openai` 没有（`:207-211`）。
- 存在两个互不等价的 token 估算器：`packages/kosong/src/tokens.ts`（JSON 内容 ×1.3）与 `agent-core-v2/src/human/llm/tokens.ts`（无 ×1.3，但有图像计价）。

## 目标

让 kimi-code 在 DeepSeek-V4.1-Flash 上的行为与 DeepSeek 官方部署对齐，并把"依赖服务端默认值"的地方逐条改成客户端可声明、可断言、可降级的形式。完整范围包含协议面、provider 面、计数面、上下文编排面、确定性面与提示词面，不含"本次不做"的条目——只有"客户端现在能做到哪一步、剩下哪一步要等端点"的区分。

## 受众

- 用 kimi-code 连接自建 DeepSeek 端点（DeepInfer + deepseek-recipe 前端，或官方 API）的使用者。
- 维护家族表、provider 定义、openai 请求层与 token 计数的开发者。

---

## 需求

每条需求都给出：**客户端现在能完成的**与**依赖外部条件的**。后者不作为范围排除，只标注验收的前置状态。

### R1 按思考档位声明输出上限

当前在调用方未显式指定上限时，DeepSeek 请求**不带** `max_completion_tokens`，完全依赖端点默认值。自建前端（vLLM 系）的默认值可能与官方 API 不同，回答被提前截断时客户端无法区分"模型写完"与"被截断"。

要求：字段未指定时，由客户端发出与 deepseek-recipe 一致的三档值（非思考 8192 / 思考 65536 / 思考 + `max` effort 131072），并与窗口余量取 min，且不超过 `CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING`。

显式传入的上限始终优先。**调用方显式传 `<= 0`（"不限制"哨兵）时必须仍然不发该字段**，不得被档位兜底覆盖。

- 客户端可完成：全部。
- 依赖外部条件：三档数值的实测校验（文档值 vs 端点实际接受值）。

### R2 token 估算误差基线

两个估算器并存且不等价，但没有任何一处记录过估算值与端点实际 `prompt_tokens` 的偏差。所有 compaction 阈值与上下文预算都建立在它们之上。

要求：

1. 先确定**哪一个是 DeepSeek 路径上 prompt 预算的权威**，并在规格与代码注释中固定该结论。
2. 为**每个**估算器建立各自的语料级基线夹具，阈值分开设定（两者对同一 JSON 语料的估算天然相差约 23%，共用阈值不成立）。
3. 夹具每条记录携带语料类别、字符数、真实 `prompt_tokens`、测量端点、测量日期、测量方式。
4. 断言按语料类别分组，使阈值具备承载力——任一估算分支被改动时，对应类别的断言必须失败。

- 客户端可完成：夹具结构、断言、分组阈值、注入点。
- 依赖外部条件：真实 `prompt_tokens` 需要一次端点测量；缺失时该任务的测试以"夹具不完整"失败，而不是跳过。

### R3 带工具请求不发送 `response_format`

按 deepseek-recipe 的约束选择规则，带 tools 且 `tool_choice != none` 的请求，`OutputConstraint` 取 tool-call 语法，`response_format` 被静默丢弃。当前客户端在 `requester.ts:116-117` 无条件赋值，且 `:131` 之后还会合并 `extraParams.openai`，两者都会让该字段发出。

要求：DeepSeek 家族在"请求带非空 tools"且"调用方设置了 response format"时，最终请求体不含 `response_format`；不带工具时行为不变；`extraParams` 无法绕过该抑制。

- 客户端可完成：全部。
- 依赖外部条件：无。

### R4 provider 与 wire type

DeepInfer 本次没有 HTTP server，客户端无法直连。但这不构成"不定义 provider"的理由：没有 provider 定义，R1/R3 的家族行为无处挂载，用户也只能手写配置。

要求：

1. **注册一个 `deepseek` provider definition**（`baseProtocol: 'openai'`），携带官方地址、凭据环境变量、能力函数与错误分类。它让 `[providers.deepseek]` 成为一等公民，也是 R1/R3 家族行为在 provider 侧的可观测锚点。
   注册前必须先判定该 id 是否已存在：用户已在配置里定义 `[providers.deepseek]` 时**不得覆盖**。`registerProviderDefinition` 对重复注册直接抛 `BugIndicatingError`，少了这层保护会让这类用户启动即崩。
2. **不新增 wire type。** 新增 wire 的前提是存在一种新的线上协议；DeepInfer 当前没有，deepseek-recipe 暴露的是 OpenAI 兼容的三种格式，已被 `openai` 与 `openai_responses` 覆盖。
3. **保留 wire 触发器**：当上游出现以下任一条件时，才进入"新增 wire"评估——(a) DeepInfer 或第三方发布非 OpenAI 兼容的 HTTP 服务；(b) `so_args` 的 ebnf/json_schema 需要独立于 `response_format` 的字段表达；(c) 出现客户端必须读取的私有响应字段。触发器与其判据写进设计文档，不写进代码。

- 客户端可完成：provider 定义、能力函数、错误分类、触发器判据。
- 依赖外部条件：wire type 本身，需上述触发器之一成立。

### R5 接入 deepseek-recipe 的真实 tokenizer

启发式估算的误差是 R2 的观测对象，但根因是"没有真 tokenizer"。deepseek-recipe 有官方实现，代价是跨语言依赖。

要求：

1. 在计数层引入可替换的 **`TokenCounter` 接缝**：默认实现是现有启发式，可注入精确实现。
2. 适配层支持三种后端形态，按可用性降级：`wasm`（首选，无外部进程）、`sidecar`（Rust/Python 进程，stdin/stdout 或 Unix socket）、`http`（前端若暴露 `/tokenize` 类端点）。三者都实现同一接口。
3. 任一后端不可用时**必须回退到启发式**，且回退事实可观测（计数结果携带来源标记），不得静默降级为 0 或抛错。
4. 精确计数接入后，R2 的基线阈值收紧为单独一组，与启发式基线并存而非互相覆盖。

- 客户端可完成：接口、三种适配器骨架、降级与来源标记、以 fake 后端驱动的注入测试。
- 依赖外部条件：真实后端二进制的产出（WASM 构建或 sidecar 可执行文件）；在它到位前，`wasm`/`sidecar` 适配器以 fake 实现通过测试。

### R6 SWA bounded replay 对应的上下文编排

`DEEPINFER_YOCO_PREFILL_KEEP_TOKENS=140` 意味着解码端只重放有界后缀，且 README 要求"该后缀需覆盖 SWA 窗口加上最大回溯长度"。也就是说：**超出该后缀的上下文在解码时不会被重新读取**。客户端看不到这个窗口，但可以决定"把什么放在尾部"。

要求：

1. 新增一个**纯判定函数**，输入当前上下文规模与配置阈值，输出"本步是否需要尾部重锚定"。
2. 需要重锚定时，通过既有 reminder 机制注入一段紧凑的"任务契约"（目标 + 硬约束），注入点位于上下文尾部而非头部。
3. 阈值可配置，默认值取保守估计并在文档中标注"未经端点测量"；真实窗口确认后只改常量，不改结构。
4. 注入必须幂等：同一会话内已注入且未被 compaction 丢弃时不重复注入（沿用 `DeepseekAdaptationService` 的 `lastInjection` 判据）。

- 客户端可完成：判定函数、reminder 变体、幂等判据、单元测试。
- 依赖外部条件：真实 SWA 窗口与回溯长度的测量；缺测量时阈值是保守常量。

### R7 推测解码与 batch-invariant / 确定性采样

DSpark、confidence-scheduled verification、batch-invariant 推理、`seq_seed` 全部是服务端行为，客户端不能复刻。客户端能做的是**参数面**：让"要求确定性"这件事在请求上可表达，并声明服务端必须配合的环境变量。

要求：

1. 新增**确定性档位**：开启时请求携带整数 `seed` 并尝试 `temperature: 0`；关闭时不添加任何相关字段。`seed` 的默认来源是模型名与首条用户消息的稳定哈希，可被显式配置覆盖。
   **思考模式下 `temperature` 会被家族声明的忽略清单删除**（`modelFamily.ts` 的 `ignoredWhileThinking`，经 `stripIgnoredSamplingParams` 生效），`seed` 保留。因此思考模式的确定性只由 `seed` 与服务端环境变量共同决定，客户端不能单方面保证——验收必须按"是否思考"分别断言，不能只测一条。
2. 确定性档位与"思考档位"正交，两者可同时开启。
3. 规格正文列明服务端需设置的 env（`DEEPINFER_BATCH_INVARIANT=1`、`DEEPINFER_ENABLE_MTP_VARLEN=0`、固定 `seq_seed`），使"客户端已声明、服务端未开启"这种半确定性状态可被识别。
4. 不在客户端模拟推测解码的任何效果（不预生成草稿、不重排 token）。

- 客户端可完成：参数面、默认 seed 派生、与思考档位的正交组合、请求体断言。
- 依赖外部条件：确定性是否真正成立，需端点实测对比；客户端只保证"请求表达了意图"。

### R8 家族识别规则与 `curated/deepseek.md`

现有识别是"取最后一个 `/` 之后做前缀匹配"。这覆盖 `deepseek-v4.1-flash`、`workbuddy/deepseek-v4.1-flash`、`xopdeepseekv32`，但漏掉网关形态 `vendor/deepseek-proxy/foo`（tail 为 `foo`）。同时家族提示词是行为面的一部分，需要随 V4.1 的工具能力一起更新。

要求：

1. 识别规则增加**网关形态兜底**：当 tail 不命中时，回退到"整串是否以家族前缀开头或包含 `/<家族前缀>` 段"，并保持最长前缀优先与大小写不敏感。
2. 新增识别用例覆盖：单段、双段、三段网关、`xop` 前缀、带版本号、以及不得命中的反向用例（`my-deepseek-clone`）。
3. `curated/deepseek.md` 增加与 V4.1 相关的内容：思考模式下必须回传全量推理、工具参数由服务端约束生成（无需客户端修复 JSON）、长上下文下以尾部契约为准。文件保持在 `MAX_ADAPTATION_BYTES`（32KB）内，且不被章节截断。

- 客户端可完成：全部。
- 依赖外部条件：无。

---

## 交付分期与外部依赖

分期只决定顺序，不决定取舍——每一项都在范围内。

| 期 | 内容 | 外部依赖 |
| --- | --- | --- |
| 一 | R1、R3、R4(provider)、R8(识别) | 无 |
| 二 | R2、R8(提示词) | 一次端点测量（R2 夹具） |
| 三 | R5 | WASM 构建或 sidecar 可执行文件 |
| 四 | R4(wire 触发器)、R6、R7 | 真实端点；R4 还需触发器成立 |

**不存在"留待独立决策"的条目。** 三、四期的每一项都有客户端侧可交付物与可在 `bun run test` 中执行的断言；未到位的只有外部输入，且该缺失会表现为测试失败而非跳过。

## 验收总则

- 每条需求的每条断言都必须能在 `bun run test` 中执行并通过；人工观察、日志目视、端点手测均不计入验收。
- 依赖外部测量的任务，其测试在测量到位前**失败**并在失败信息中指明缺失项，不得 `skip`。
- 不引入新的运行时可选依赖；R5 的三种后端以接口与 fake 实现先行落地。
- 代码改动遵循 `AGENTS.md` 与 `CONVENTIONS.md`；`packages/agent-core-v2` 属 comment-free 区域，该约束以 `AGENTS.md` 为准。
