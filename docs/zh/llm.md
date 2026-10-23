# LLM 模块设计指南

本页是 `packages/agent-core-v2/src/human/llm` 的设计指南。改动该目录下任何文件前先读它。它记录这个模块赖以成立的分层规则及其理由，好让一处看起来局部的改动不会悄悄破坏引擎其余部分依赖的边界。

## 分层

LLM 模块分三层，import 只能单向。

```
human/llm            纯内核：消息、模型、协议形状、请求器
human/llm/requester/bases/<protocol>   按 wire 编解码
llm-adapter          v2 兼容边界
```

- **`human/llm` 是纯内核。** 它永不 import v2 域（`app/`、`features/`、`state/`、`workspace/`、`_base/`、`llm-adapter` 等）。这一点由 `packages/agent-core-v2/scripts/check-import-boundaries.mjs` 强制执行，违规直接让构建失败，而不是留给 review 兜。内核必须能在没有引擎 DI 容器、资源与配置的情况下被加载。同一条规则也解释了内核为什么在 `human/log/log.ts` 声明自己的日志端口，而不是去引 `#/_base/log/log`：需要内核上报时由调用方传入 logger，没有 logger 时内核保持沉默。
- **`kosong` 是冻结的遗留内核。** `agent-core-v2` 里任何代码都不得 import 它；provider 与请求代码位于 `human/llm`，v2 兼容边界是 `llm-adapter`。边界检查会直接拒绝该 import 路径。
- **`#human/*` 是内核的公开路径。** 包内 `human/` 之外的文件通过 `#human/...` 触达内核；`human/` 之内的文件用 `#/...`，该别名在内核根下解析。

## 请求器流水线

`human/llm/requester/bases/` 下的每个协议都遵循同一形态：

| 文件 | 职责 |
| --- | --- |
| `trait.ts` | 供应商专属钩子。可选；钩子缺席意味着"走默认"。 |
| `contract.ts` | trait 与 format 共同使用的中立 wire 与 chunk 类型。 |
| `format.ts` | 请求组装、流解析、lowering 入口。 |
| `lower.ts` | 消息转换，一个中立 `Message` 进，wire 消息出。 |
| `usage.ts` | 该 wire 的用量字段语义。 |
| `requester.ts` | 接线：建客户端、调用 `prepare<Protocol>Request`、执行流。 |

两条规则防止这层缠成一团：

1. **`format` 与 `trait` 互不 import。** 双方只使用 `contract.ts` 里的中立类型。边界检查会强制这一点，否则产生的互相依赖要等到有人改其中一侧时才会暴露。
2. **`format`、`lower`、`patterns`、`reasoning-key` 是流水线内部件。** 只有 `bases` 代码及其测试可以 import 它们；其余一切只说 `contract`、`trait`、`requester`。需要新行为的调用方应当在 trait 或公开的 requester 表面上找到它。

## 新规则该放哪里

给新规则选对位置就是设计工作的大部分。三个问题决定它：

- **它是关于 wire 的事实，还是某个供应商的偏好？** wire 事实（字段怎么命名、什么样的负载合法）属于 `format`/`lower`。可能随模型而变的供应商行为属于家族表或 trait。
- **它依赖的是请求形态，而不是供应商身份？** 像"当请求带 `tools` 时，必须先前的推理完整回放"这样的要求，触发条件是请求里有什么，而不是谁在服务它。这类规则属于 `llm/modelFamily.ts`，并从请求本身求值。把它们建模成 trait 钩子会把它们藏在一个可能根本不存在的 provider 注册之后。
- **它是按模型的常量？** 计价形态、effort 词表与 prompt 形态放在 `human/llm/modelFamily.ts` 的家族表里。别把 wire 编码放进那张表——它属于协议基类。

## 模型家族

`human/llm/modelFamily.ts` 是一张按家族组织的常量表，通过把归一化后的模型名与声明的前缀匹配来解析。最长前缀优先，因此 `xopdeepseek*` 与 `deepseek*` 可以共存。

每个条目可以带：

- `promptShape` —— 选择 profile catalog 渲染哪套系统提示词模板。`minimal` 模板有意只引用少量变量；见下面关于被丢弃变量的说明。
- `imagePricing` —— 视觉 token 计价的常量。它们是从真实端点校准推导出的启发式，不是公开公式。其背后的测量（公式 → 实测值，以及偏差）记录在交付该公式的 changeset 里；`scripts/measure-image-tokens.cjs` 是裁判，两边不一致时用它对着真实端点重测并同步校准。把这些数字当作估计值，并且即使 `fallbackTokens`（尺寸未知）与 `tokenCap`（网格上限）当前取值相同，也必须让两者保持独立：端点对任一侧的变化都不应带动另一侧。
- `reasoningEffort` —— 历史中已带推理时发送的 effort 值。
- `thinkingHistory` —— 由请求形态驱动的推理规则：`fullEchoWithTools` 用于那些只要 `tools` 存在就要求完整思维链的家族，`ignoredWhileThinking` 用于端点接受但不产生作用的采样参数。

其中两条规则值得单独写出来，因为上游把两者都记为硬性要求而非偏好：

- **完整推理回放。** 只要请求带 `tools`，DeepSeek 就要求把 `reasoning_content` 完整传回，包括没有发生工具调用的轮次；省略它的请求会以 HTTP 400 失败。因为触发条件是请求形态，这个判断放在 `fullReasoningEchoRequired(model, hasTools)`，由请求器从 `tools.length` 求值，而不是走 trait 钩子。
- **被静默忽略的采样参数。** thinking 模式接受 `temperature`、`presence_penalty`、`frequency_penalty`，既不报错也不生效。它们在"请求形态仍然可见"的最后一个位置被裁掉，而且只裁家族自己声明的那些名字；其余每一个键都原样通过。

effort 词表是多对一收敛而不是集合不匹配（`minimal`→low、`low`→low、`medium`→high、`high`→high、`xhigh`→high、`max`→max），因此多个请求值会落到同一个实际 effort。目前只有历史默认值被消费。

`maxOutputDefaults` 承载家族希望在调用方未指定上限时应用的三个输出上限（非思考、思考、思考且 `max` effort）。请求器只把它当作最后一层兜底——显式调用方上限与 provider trait 都优先——并将它与剩余上下文窗口取 min。

## 用量核算

用量解析每条 wire 只有一个归属，其规则说的是字段的**含义**，而不是谁发来的。`human/llm/requester/bases/openai/usage.ts` 先读 DeepSeek 的缓存拆分（`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`），再回退到 OpenAI 形态的缓存计数（`cached_tokens`、`prompt_tokens_details.cached_tokens`），并拒绝两侧不可能同时成立的拆分：hit+miss 之和**大于** `prompt_tokens` 属自相矛盾，改用 OpenAI 字段。之和仅仅**小于** `prompt_tokens` 不是错误——端点可能只上报了拆分的一部分。被拒绝的 `prompt_cache_miss_tokens` 会保留在解析结果上，好让上报在字段本身被清空后仍能展示它。

同一条规则也存在于 `packages/kosong/src/providers/openai-common.ts`，因为 `kosong` 是独立冻结的内核，两个包不得互相 import。改这条规则时两处都要改。`packages/kosong/test/cache-field-parity.test.ts` 把同一批负载喂给两套实现，不一致就让测试失败——它是唯一让两份拷贝保持一致的东西，所以扩展规则时也要扩展它的用例表。

## Prompt 形态与被丢弃的变量

`renderPrompt` 只替换模板引用到的变量，其余原样保留，因此当前模板从未提到的变量会静默消失。profile catalog 为此做了补偿：

- `renderSystemPromptResult` 与 `renderPromptTemplateResult` 返回 `droppedVars`，列出"提供了但未被引用"的变量。调用方会记录它们。这个列表是内容丢失的唯一信号：渲染器有意丢弃未知变量，因为同一个 helper 要服务多套模板。
- `minimal` prompt 形态只保留人格与工作目录。在该形态下，AGENTS.md 内容、技能列表、插件段与 model-adaptation 段根本不会进入提示词。任何依赖这些内容在场的逻辑都必须检查 `droppedVars`，而不是假定已投递。
- 正因为 AGENTS.md 正文进不了 `minimal` 系统提示词，注入记账就不能把这些路径标记为"已投递"：那会压掉另一条指向它们的 reminder。只把模板真正承载过的路径记为已投递，其余保持可被该 reminder 命中。
- 有些模板引用的是组合块（`skills_section`）而不是它构建自的原始变量（`skills`）。模板点名了块，就说明内容已投递，即便原始名字从未出现，因此不得把原始变量报为丢弃。块到变量的配对是显式声明的，而不是从名字推断；由本身并非变量的东西组合出的块（`plugin_sections`、`model_adaptation_section`）没有可配对的对象。
- `valueDelivery` 为每个未被 profile 承载的非空变量给出分类：由独立通道投递的内容（model adaptation）标为 `reminder`；profile 有意不携带的内容（AGENTS.md、技能、插件、附加目录）标为 `intentionally_omitted` 并附原因。因此一次成功渲染不存在未分类的非空变量；未解析的 `${name}` 会产生 `warnings` 条目，而不是算作已投递。
- `contractDelivery` 按 profile 报告 `behaviorContract.ts` 的六条核心行为契约：full 形态六条都在 system prompt 中；minimal 形态在模板里承载两条，其余四条交给 adaptation reminder，若该家族没有 reminder 通道则标记为 `intentionally_omitted`。

## 模型适配

`app/agentProfileCatalog/model-adaptations/curated/` 存放手写的家族指引，每个家族通过家族表声明的前缀解析到它。因此带版本号或用供应商限定的 id（`deepseek-v4-pro`、`xopdeepseekv32`、`workbuddy/deepseek-v4.1-flash`）不需要自己的适配文件。

这里有意不设第二种适配文件。曾经存在一个 `measured/` 目录，它随读取它的机制一起被删除，因为本仓库没有任何东西会写这类文件：`scripts/prompt-optimizer probe` 把 JSON 写进被 gitignore 的 `reports/` 目录，而没有任何代码路径指向 `model-adaptations`。当时随它发布的每个文件都是把手工数字冒充成 probe 输出，且针对的是已经退役或从未存在过的 wire id。如果将来真的做出生产者，请把它与写出它的代码**一起**重新引入——没有生产者的文件是不可核验的断言。

文件上限 32 KiB。超限文件会按 `##` 章节边界切开而不是整份丢弃，因为这些文件是手写的、按 `##` 组织：按边界切保留完整的指引章节，而因为最后一段太长就丢掉整份文件会丢掉全部内容。文件开头通常放着最重要的指引，所以当连第一节都放不下时，硬切退回到按上限截断，调用方仍能得到那个开头而不是什么都没有。

边界扫描会跟踪围栏代码块。围栏里的 `##` 行是被引用的内容而不是章节边界：这些文件会在围栏里引用示例提示词，把被引用的标题当成边界可能在块内切断，留下未闭合的围栏并把余下指引框成代码。围栏记录为 **span** 而不是 open offset，这样硬切才能问"上限是否落在**这个**围栏内"，包括在文件更下方才闭合的围栏。若围栏正好开在文件最开头，就没有内容可保留，这种情况退回普通切割而不是返回空串。缩进代码块无需处理——它们的行以空白开头，根本匹配不到标题。

两条投递通道互补，一个家族恰好由其中一条服务：

- **reminder 注入** —— 用于 `promptShape` 为 `minimal` 的家族。那些模板没有 `${model_adaptation_section}` 占位符，所以提示词路径只能把文件加载进来再让渲染器把它报成丢弃变量。`adaptationDeliveredByReminder` 命名了这种情况，`features/deepseekAdaptation` 实现了它。
- **系统提示词段落** —— 用于将来任何带手写指引但不是 minimal 形态的家族。

`loadCuratedAdaptation` 与 `hasCuratedAdaptation` 以家族是否声明 `curatedAdaptation` 为门，因此未注册的模型永远不会被塞指引。

reminder 是组合出来的而不是直接复制的：`renderCuratedAdaptation` 先写入 minimal 形态委派出去的四条核心契约，再声明这些指引是手写而非实测所得，最后把 curated 正文接在 `## Working rules delegated by the minimal prompt` 段之后。因此 minimal 形态的会话拿到的六条契约与 full 形态一致，只是分散在两条通道上，而不是在两处各写一遍。

reminder 侧按 wire name 缓存的是**进行中的加载**，而不是已落定的值。provider 是异步的，reminder 服务可能在任何一步询问，因此两个调用方可能在任一写入完成前重叠；缓存 promise 意味着无论多少调用方竞争，文件只读一次。解析出的 `undefined` 会被当作真实条目保存，这样没有适配的模型不会每步重读目录。

文本也是从 wire name 派生的——它在会话中不会变——而不是每步从对话重新派生。每步重新派生会带来每步一次文件读取，并把注入点反复放回上下文尾部，而那里正是缓存前缀最容易被失效的位置；该值只需在 compaction 丢弃它之后重建一次。

## 测试

本模块的测试位于 `src/human/test/llm/`（内核级）与 `test/`（引擎级）。优先断言 wire 形状与解析顺序，而不是断言某个函数被调用过：这个模块实际出过的 bug 是优先级错误与静默丢弃，两者对调用次数断言都是不可见的。
