# 任务拆分（完整范围）

依赖关系：`T1 → T2`、`T6 → T7`、`T9 → T10`、`T11 → T12`。其余任务相互独立。`T14`、`T15` 收尾。

每条的验收都必须是 `bun run test` 里能失败的断言。凡标注**反证**的条目，说明该断言凭什么会挂。

---

## 一期：家族与协议面

### T1 家族表增加档位常量

**改动**：`packages/agent-core-v2/src/human/llm/modelFamily.ts` —— `ModelFamilyProfile` 增加 `maxOutputDefaults?: { nonThinking; thinking; thinkingMaxEffort }`；`deepseek` 条目填 `8192 / 65536 / 131072`，常量对象 `Object.freeze`。

**验收**

1. `resolveModelFamily('deepseek-v4.1-flash')?.maxOutputDefaults` 深等于 `{ nonThinking: 8192, thinking: 65536, thinkingMaxEffort: 131072 }`。
2. `Object.isFrozen(...maxOutputDefaults)` 为 `true`。
3. `resolveModelFamily('workbuddy/deepseek-v4.1-flash')` 与 `resolveModelFamily('DeepSeek-V4-Pro')` 返回同一组值。
4. `resolveModelFamily('gpt-4o')?.maxOutputDefaults` 为 `undefined`。

### T2 档位兜底与哨兵短路

**改动**：`packages/agent-core-v2/src/human/llm/requester/bases/openai/requester.ts:119-130` —— 新增 `familyDefaultCap(input)`；`requested <= 0` 时短路为 `undefined` 且**不进入**任何兜底。

**验收**（对最终请求体断言）

1. `thinking` 缺失 → `max_tokens: 8192`。
2. `thinking: { effort: 'high' }` → `65536`；`{ effort: 'max' }` → `131072`。
3. 显式 `maxCompletionTokens: 1000` → `1000`，档位不覆盖。
4. **显式 `maxCompletionTokens: 0` → 请求体既无 `max_tokens` 也无 `max_completion_tokens`。**（反证：删掉 `sentinel` 短路，此条立即失败，其余条目全绿——它专门锁这一条回归。）
5. `usedContextTokens` 使余量为 500 → 取 `500`。
6. 余量为 `0` 或负数 → 取 `1`（`Math.max(1, …)`），不是不发。**断言具体值，不留歧义**。
7. 非 DeepSeek 模型（`gpt-4o`）在同样输入下不含该字段。
8. 档位值被 `CHAT_COMPLETIONS_MAX_OUTPUT_TOKENS_CEILING` 截断：构造余量 `200000`，断言最终值 `131072`。

### T3 `response_format` 抑制点后移

**改动**：`.../openai/requester.ts` —— 抑制放在 `:131` 的 `extraParams` 合并之后，与 `stripIgnoredSamplingParams` 同位置。

**验收**

1. tools 非空 + `responseFormat` + `deepseek-v4.1-flash` → 无 `response_format`。
2. tools 非空 + `responseFormat` + `gpt-4o` → 有。
3. tools 为空 + `responseFormat` + `deepseek-v4.1-flash` → 有。
4. **tools 非空 + `deepseek-v4.1-flash` + `extraParams.openai.response_format` → 仍然无。**（反证：把抑制留在 `:116-117`，此条失败。）
5. 抑制时 `tools` 字段完整保留，未被连带删除。

### T4 `deepseek` provider 定义

**改动**：`packages/agent-core-v2/src/llm-adapter/provider/provider-definition.ts` —— 注册 `id: 'deepseek'`、`baseProtocol: 'openai'`、`endpoint`（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `defaultBaseUrl`）、`capability`、`classifyError`。

**验收**

1. `getProviderDefinition('deepseek', 'openai')` 返回定义，其 `endpoint.defaultBaseUrl` 为 `https://api.deepseek.com`。
2. `capability('deepseek-v4.1-flash')` 返回 `thinking: true`、`tool_use: true`，且 `isUnknownCapability(...)` 为 `false`。
3. **重复注册不崩**：先注入一个同 id 定义，再执行注册，断言 `hasProviderDefinition('deepseek')` 为真且原定义未被覆盖。（反证：去掉 `hasProviderDefinition` 保护，`registerProviderDefinition` 在 `:73-77` 抛 `BugIndicatingError`。）
4. **未新增 wire type**：断言 `KNOWN_WIRE_TYPES`（`packages/kosong/src/catalog.ts`）不包含 `'deepinfer'`，且 `deepseek` 定义仍只注册在 `openai` 协议下。（反证：任何人顺手加 wire，此条失败。）
5. 未注册 `openai_responses` 变体：`getProviderDefinition('deepseek', 'openai_responses')` 为 `undefined`。

### T5 家族识别增加网关兜底

**改动**：`packages/agent-core-v2/src/human/llm/modelFamily.ts:108-127` —— tail 不命中时按 `/` 切段，逐段判断段首是否以家族前缀开头；最长前缀优先与大小写不敏感保持。

**验收**

1. `vendor/deepseek-proxy/foo` → 命中 `deepseek`。
2. `my-deepseek-clone` → **不命中**（段首匹配约束）。
3. `openrouter/deepseek/deepseek-v4` → 命中。
4. `xopdeepseekv32` → 命中。
5. `DeepSeek-V4-Pro` → 命中（大小写不敏感）。
6. 现有 `modelFamily.test.ts` 的全部用例保持通过（最长前缀优先未被破坏）。

---

## 二期：计数与提示词

### T6 单一计数出口

**改动**：以仓库既有 DI（`createDecorator` / `Service`）暴露 `IPromptTokenCounter`，prompt 预算与 compaction 通过它取数；默认实现委托现有估算器，行为不变。

> 设计细化：design.md D2 要求"被断言的函数"与"预算实际用的函数"是同一个。硬编码 import 无法在测试中替换，因此以 DI 实现该同一性。

**验收**

1. 默认注册下，预算结果与改造前完全一致（对固定输入断言具体数值）。
2. 注入一个返回固定值（如 `42`）的实现后，compaction 阈值判定随之改变——构造一个"按旧估算该压缩、按 `42` 不该压缩"的用例，断言不再触发压缩。（反证：预算路径若绕过该服务，此条失败。）
3. 服务未注册时回退到默认实现，不抛错。

### T7 双基线夹具与分组断言

**改动**：新增夹具 JSON + 测试，分别覆盖 `countPromptTokens`（agent-core-v2）与 `packages/kosong/src/tokens.ts`。

**验收**

1. 夹具每条含 `category`、`chars`、`promptTokens`、`endpoint`、`measuredAt`、`method`；任一字段为空时测试失败（不是 `skip`）。
2. `cjk-prose`、`ascii-code`、`json-args` 各一条断言，阈值分别为常量，失败信息打印实际偏差百分比。
3. 两条基线阈值各自独立，互不引用。
4. **乘数承载性**：对 `json-args` 语料同时计算 `estimateTokens`（不含 ×1.3）与 `estimateTokensForJson`（含 ×1.3），断言两者比值落在 `[1.25, 1.35]`。**反证：把 `JSON_TOKEN_MULTIPLIER` 改成 `1.0`，此条立即失败。**（该断言不需要修改源码来验证，因此可自动化。）
5. 夹具缺失真实 `promptTokens`（仅占位）时，测试失败并指出"缺少端点测量"。

### T8 家族提示词更新

**改动**：`packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/curated/deepseek.md` —— 增加三节：思考模式下全量回传推理、工具参数由服务端约束生成（客户端不做 JSON 修复）、长上下文以尾部契约为准。

**验收**

1. `loadCuratedAdaptation('deepseek-v4.1-flash')` 的渲染结果包含上述三节的标题文本。
2. 渲染结果字节数 `< MAX_ADAPTATION_BYTES`（32KB），且包含文件**最后一节**的标题——证明未触发 `truncateAtSection`（`modelAdaptations.ts:125-172`）。
3. 既有 `adaptationRender.test.ts` 与 `modelAdaptations.test.ts` 全部通过。

---

## 三期：真实 tokenizer 接缝

### T9 `TokenCounter` 接口与降级链

**改动**：新增同步 `TokenCounter` 接口（`count(text): number`）与 `source: 'heuristic' | 'wasm' | 'sidecar' | 'http'` 标记；默认实现是启发式；构造失败按 `wasm → sidecar → http → heuristic` 降级。

**验收**

1. 类型层面断言 `count` 返回 `number` 而非 `Promise<number>`（同步接口）。
2. 默认实现 `source === 'heuristic'`。
3. 注入 fake `wasm` 实现后 `source === 'wasm'` 且计数改变。
4. 注入一个构造函数抛错的 `wasm` 实现 → 不抛错、`source === 'heuristic'`、计数等于默认值。
5. 计数器返回 0 或负数时被拒绝（回退到默认值），不把 0 当有效计数。

### T10 三种后端骨架

**改动**：`wasm` / `sidecar` / `http` 三个适配器骨架实现同一接口；真实二进制缺失时以 fake 实现通过测试。

**验收**

1. 三个骨架都能通过同一组契约测试（给定输入返回相同计数）。
2. `sidecar` 与 `http` 标记为 Tier B：断言它们不出现在 `prepareOpenAIRequest` 的同步路径上（`prepareOpenAIRequest` 返回类型不含 `Promise`）。
3. 骨架在二进制/端口不可用时抛出的错误被 T9 的降级链捕获，调用方只看到 `source === 'heuristic'`。
4. 未引入任何新的运行时可选依赖：测试内硬编码一份允许的 `dependencies` 基线列表，断言 `packages/agent-core-v2/package.json` 与 `packages/kosong/package.json` 的 `dependencies` 键集合与该基线完全相等。（反证：加任何新依赖，此条失败。）

---

## 四期：编排与确定性

### T11 尾部重锚定判定函数

**改动**：新增纯函数 `shouldReanchorTail({ estimatedTokens, threshold, lastAnchorTokens })`。

**验收**

1. `estimatedTokens = threshold - 1` → `false`；`= threshold` → `true`（边界取 `>=`，断言具体行为）。
2. 已有 anchor 且 `estimatedTokens < threshold` → `false`。
3. 函数无副作用：同参数连续调用返回同值；不读写模块级状态（以"两个不同实例/两次调用结果一致"断言）。

### T12 尾部契约 reminder 变体

**改动**：新增 reminder 变体，注入紧凑"任务契约"（目标 + 硬约束）；幂等沿用 `deepseekAdaptationService.ts:76-87` 的 `lastInjection` 判据。

**验收**

1. 首次超阈值 → 返回非空内容，且内容同时包含"目标"与"硬约束"两段标识。
2. 同一会话再次调用且 `lastInjection` 非空 → 返回 `undefined`。
3. 模拟 compaction 后 `lastInjection` 为空 → 再次返回非空。
4. 内容长度在常量上限内（断言具体上限值），避免每步都塞长文。

### T13 确定性档位

**改动**：新增正交档位 `determinism`；开启时请求带整数 `seed`，默认由模型名 + 首条用户消息稳定哈希派生。

**验收**

1. `determinism` 开 + 非思考 → 请求体含整数 `seed` 与 `temperature: 0`。
2. `determinism` 开 + 思考 → 含 `seed`，**不含 `temperature`**（被 `stripIgnoredSamplingParams` 删除，`requester.ts:135-138`）。**反证：不断言该差异，实现者会误以为思考模式也发了 temperature。**
3. `determinism` 关 → 两者均不含。
4. 同一会话两次调用 `seed` 相同；首条用户消息不同则 `seed` 不同。
5. 显式配置的 `seed` 覆盖派生值。
6. `determinism` 与 `thinking` 的四种组合各有一条断言。

---

## 收尾

### T14 changeset

**改动**：新增 `.changeset/<name>.md`，说明 `max_tokens` 行为变更与 `response_format` 抑制。

**验收**

1. 文件存在且 front-matter 含受影响的包名。
2. 正文明确写出"未显式指定上限时现在会发送家族档位"这一用户可感知变更。
3. 正文通过 front-matter 解析后，受影响的包名列表非空且与预期集合相等（断言具体集合，不是"包含至少一个"）。
4. 正文不含未替换的占位符（断言匹配 `<[a-z-]+>` 的出现次数为 0）。

### T15 提交前校验

**验收**：仓库根目录依次执行，全部退出码 `0`：

1. `bun run typecheck`
2. `bun run test`
3. `bun run lint`
4. `bun run check:no-comments`

任一失败回到对应任务修正，不以"与本次改动无关"跳过。

---

## 任务与需求的对应

| 需求 | 任务 |
| --- | --- |
| R1 | T1、T2 |
| R2 | T6、T7 |
| R3 | T3 |
| R4 | T4 |
| R5 | T9、T10 |
| R6 | T11、T12 |
| R7 | T13 |
| R8 | T5、T8 |
| 收尾 | T14、T15 |
