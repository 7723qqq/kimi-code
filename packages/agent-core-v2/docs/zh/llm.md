# llm 模块指南

llm 是 human 层内一个独立的 LLM 请求库（`src/human/llm/`），提供「一次 LLM 请求」的完整能力：多协议（openai / openai-responses / anthropic / google-genai）请求编解码、流式事件、thinking、媒体、错误分类、重试与恢复、provider 与模型目录管理。它不依赖也不感知任何外部 agent 框架，所有职责划分与扩展方式都遵循下述设计原则。

## 设计原则

1. **最小边界：llm = 「单次请求」**。核心通过 `createRequester().with(...)` 组合请求，并由 `generate` 返回 `LlmOutcome`。请求内容直接使用带可选 `MessageAttributes` 的 `Message`，随行属性在 resolver 与 legalize 阶段全程保留，仅在最终转换为 `NativeModule` 时一次收敛（同时完成工具错误与空输出状态渲染）；返回结果包含带真实 model、usage、finish 等 `attributes` 的 `AssistantMessage`。catalog 刷新状态、session 用量台账、compaction、switch、媒体文件系统和 turn 编排都不在核心内，也不存在外层 `HistoryEntry` 包装、第二套 requester 或兼容事件协议。
2. **流式优先；outcome 与事件各司其职**。核心执行返回 `done / failed / aborted` 的 `LlmOutcome`，同时按到达顺序发出 `LlmRunEvent`。完成、失败、中断和重试 partial 输出共用 `AssistantMessage` 构造；retry 事件中的 partial 仅用于诊断和流式重置，不写入历史，Loop 只把最终 outcome message 追加到历史，无需重建模型元数据。`streamLlmRequest` 把同一事件联合以 `AsyncIterable` 暴露给 transport，最终以携带 outcome 的 `llm.ended` 收尾。流式与非流式共用解码器：`stream: false` 使用 `send`，再把完整响应经同一解码器 replay。事件词汇统一为 `llm.started / requested / queued / notice / delta.* / retry / ended`；生成失败直接返回，tool-call 边界使用 decoder 回调，不再使用 `attempt.*` 事件。
3. **pipeline 屏蔽协议差异；协议补丁表达供应商定制**。每个协议都是 `defineProtocol` 对象（`packages/core/src/llm/protocol/protocol.ts`）：`runPipeline` 组合编码阶段（cacheKey → thinking → responseFormat → maxOutputTokens → sampling → tool → message → mergeTurns → annotate → finalize → flatten），前置 legalize 处理媒体、工具调用 id、供应商 pattern、thinking 历史和模型规则。协议同时提供流式 decoder、非流式 replay、错误 decoder 以及 client/send/sendStream 传输。供应商经 `protocol.with(patch)` 派生协议；Kimi 位于 `packages/core/src/llm/builtin/provider/kimi/protocol.ts`。endpoint 声明和环境变量回退统一由 `packages/core/src/llm/endpoint.ts` 解析。
4. **两层错误模型**。本地校验抛出 `llm/protocol/errors.ts` 的 `SyntaxRequestFormatError`，由 `toLlmSyntaxErrorMessage` 转换。协议与传输失败形成 failed `LlmOutcome` 中的 `LlmErrorMessage`，保留 status 字段、原始错误、request id 和协议诊断。协议可通过可选 `diagnoseError` 从当前 attempt 提取供应商专属信息，不再对外暴露通用 `traceId`。调用方直接消费 core 错误值，不再经过第二套错误联合。
5. **无状态核心 + Loop 持有编排**。核心 requester 是 protocol、endpoint、model、profile、content 和 policy 各维度的不可变组合。`ProtocolAdapterRegistry` 为每次请求初始化核心实例，`AgentLoopService` 是 Agent 级请求门面的唯一长期持有者。其他 Agent Service 通过 `loopService.requester` 发起 side request、读取凭据、上传能力和请求快照，不再注入另一套 requester Service。结构投影、媒体解析及其 recovery 都通过已注册 policy 在每个 attempt 内运行，外层重试仍由 turn 机器与 Loop 驱动，凭据恢复使用 core 共享 policy。settle 持有 attempt 级消息累积器、发出规范化流式 parts、使用解析后的工具描述（包括 deferred 项）校验完整 tool-call 参数、判定空响应、记录计时，在每个 attempt 入口发出带旧版请求摘要的 `llm.requested`，并合成 outcome。参数非法时以 `invalid_tool_arguments` 重试且不执行调用；下一次 attempt 只携带临时 system 校验提醒，不携带被拒绝的调用，该提醒不会写入会话 journal。每次重试/恢复都会创建新的累积器；Loop 使用最终 outcome message 写入完成或中断历史，不再维护另一份累积器。
6. **不做静默回退**。配置严格按给定使用；不支持的 beta 特性、thinking 配置、媒体和空响应会明确失败，不会暗中切换行为。参数校验只覆盖新完成的 tool-call，既有会话历史保持原来的编码与回放行为。只有解析后的 schema 接受 `{}` 时，空参数才按无参数调用处理。
7. **一切可变能力都是贡献点**。协议补丁、媒体上传/降级、usage、协议错误诊断和恢复策略围绕核心接入。核心不引用 v2 DI、models-dev 或 catalog 状态。
8. **数据即数据**。`LlmModelSpec` 和 `LlmRequest` 都是可序列化的核心契约。核心消息沿用既有 `imageUrl/audioUrl/videoUrl` 媒体 part；data URL、`kimi-file://` 会话引用和上传后的 `ms://` 文件 id 都保留在这些 part 中。`ModelCatalog` 只负责模型与供应商元数据和默认模型选择，不缓存 requester，也不提供 generate/ping。上传能力由 `LlmEndpoint.files` 声明，媒体 resolver 从 Loop 接收模型与已初始化的 requester。`SessionMediaStore.put` 保存 bytes 与元数据并返回 `kimi-file://` 引用，`get` 负责读回。ReadMediaFile 只生成引用；Media Resolver 在下一次请求中根据本次模型、协议媒体能力、endpoint files 与 endpoint 凭据恢复完成物化。v2 历史与外部 wire 的消息形状保留在 `src/human/message.ts`；codec 只处理 role 与 envelope，不再引入第二套媒体表示。
9. **消息转换用编译器范式**。通用消息经有序、独立的 pattern 和最终 lowering 转成协议载荷；工具消息转换与媒体映射也是 pattern。main 的工具结果占位、reasoning details 和各供应商特有 wire 行为继续由既有测试约束。

## 架构

```
llm/
├── message.ts            通用 Message 模型（按 role 拆分；tool 声明独立）
├── model.ts              LlmModel：纯数据，provider+model+endpoint 覆盖
├── capability.ts / thinking.ts / usage.ts / finish-reason.ts / response-format.ts / syntax-errors.ts
├── errors.ts             LlmErrorKind 两层（syntax | remote 各细分 kind）
├── toolCallIdNormalizer.ts  流式 tool call id 去重：重复的 raw id 按序重映射为新 id
├── empty-response.ts     emptyResponseError：空响应判定纯函数，由 turn 在 llm.done 时转为 llm.failed.remote
│
├── protocol/             协议通用层（跨基座共享）
│   ├── base.ts           ProtocolName / ProtocolBase<TTrait> / ProtocolRequesterOptions / TraitContext
│   ├── format.ts         ProtocolFormat：createStreamParser(sink 回调 + resolveUsage 选项)
│   ├── connection.ts     ProviderConnection：endpoint 环境变量声明 + 默认 headers
│   ├── thinking.ts       ThinkingStrategy → ThinkingContribution → applyThinking → AppliedThinking
│   └── patterns.ts / rewrite.ts   MLIR 式 Pattern Rewriter（Message N:M 转换）
│
├── requester/
│   ├── requester.ts      LlmRequester.generate(config, content, control)；
│   │                     ExtraParams 按协议带类型 {openai?, responses?, anthropic?, googleGenai?}；
│   │                     LlmRequestConfig.credentialProvider：凭证贡献点
│   │                     （resolve/canRecover/invalidate），由调用方在每次 attempt 前解析；
│   │                     工厂与 credentialsRecovery 策略位于 human/credentials
│   │                     （createStaticCredentialProvider / createOAuthCredentialProvider；createKimiOAuthCredentialProvider
│   │                     适配 Kimi OAuth token）；供 direct 调用方使用的
│   │                     runWithCredentialRecovery / streamWithCredentialRecovery 执行器
│   │                     位于 src/llm-adapter/model/credential-recovery
│   ├── actor.ts          请求 actor：包装单次请求的 fromCallback
│   │                     （messageResolvers、abort 作用域、事件 sendBack），由 turn invoke
│   ├── retry.ts / recovery.ts   重试/恢复策略纯函数（由 turn machine 驱动；propose 为纯函数）
│   └── bases/            五个协议基座：openai / openai-responses / anthropic / google-genai / antigravity
│                         各自含 contract / format / lower / patterns / capability / extra-params / trait / requester
│                         （公开接缝：contract / trait / requester；format / lower / patterns 保持内部）
│
├── provider/
│   ├── definition.ts     ProviderDefinition{id, protocols{base+trait+connection+classifyError+capability}, media, models}
│   │                     createProvider()（无 registry）→ Provider{listModels, resolveModel, createRequester}
│   └── providers/        standard 等内建 provider（经贡献点注册）
│
├── provider-catalog.ts   xstate 状态机：refresh/upsert/remove/ping 输入，changed 输出；
│                         provider -> models 结构；远程 pulled 与本地 models 双真相源
│
└── media/                媒体贡献点：cache / degrade / ref / resolver / store / upload
```

请求生命周期：`generate` 收到 (config, content, control) → 调用方在每次 attempt 前把 `config.credentialProvider` 解析成带完整凭证的 model（machine 路径由 request actor 完成），请求因此始终携带新鲜凭证，而凭证刷新恢复（可恢复的 401 → `credentials.invalidate()`，以 `llm.recovering`（strategy 为 `credentials`）发出）在重发时自然重新解析（不经状态机的 direct 调用方——ping、generate、full compaction、媒体上传——通过 `runWithCredentialRecovery` / `streamWithCredentialRecovery` 共享同一套单次重试恢复） → requester 的 `prepare*Request` 函数将纯 format 阶段与 trait hooks 组合为协议 requestParams（format 将通用 Message[] 经 Pattern Rewriter 降低，trait 在其间调整 kwargs、转换消息、合并历史、转换 tools 并收尾 params） → `execute*Request` 调用官方 SDK → 流式 chunk 经无状态 parser 回调转换为 `llm.streaming.part / streaming.usage / streaming.finish / streaming.message_id` 事件 → 错误由 format 转换为 `llm.failed.*`；成功时 requester 发出 `llm.done`，失败时以 `llm.failed.syntax / llm.failed.remote` 收尾、不再发 `llm.done`。turn 在 `llm.done` 时经 `emptyResponseError` 判定空响应并重新转为 `llm.failed.remote`；turn machine 对 `llm.failed.remote` 先尝试恢复（由 engine 组装的策略链——可恢复 401 的凭证刷新在前、替换消息策略在后——经纯函数 `propose` 产出带不透明 `beforeNextAttempt` 副作用的记录，发 `llm.recovering`），再按策略 backoff 重试（尊重 Retry-After，发 `llm.retrying`），耗尽后才将 turn 置为失败。turn 持有 HistoryAccumulator 随事件流累积，在 `llm.retrying / llm.recovering / llm.request.retrying` 时 rollback 并重建累加器，`llm.done` 时 finish 出完整消息；usage 统计、trace、compaction、媒体降级均以插件/贡献点身份挂接在事件流上。

动态工具披露只决定请求视图，不是执行权限。Agent 在 MCP 初始化后持久化初始注册表快照，并按顺序保存运行期变更；后续请求把实时注册表协调进这份账本，不再重建初始快照。支持动态加载的模型从 active 版本投影，通过 deferred 工具、added/removed 公告和 SelectTools 经 `loop.remind` 写入的 schema system message 获取定义。loaded 状态要求精确匹配 active schema 版本。同名修改会让 active schema 和执行器在当前运行会话内保持不动，并在每个服务实例内只发送一次 reminder，而不是替换选择或发出 remove+add。普通 compact 和模型切换不会应用更新；新会话使用重新构建的注册表。不支持动态加载的模型只使用初始顶层工具，初始 deferred 仅在 Resolver 副本上提升为普通工具，运行期新增版本继续过滤，变更保留为文字 system-reminder，而不是动态 schema 或 select 指令。模型切换不会改写持久化快照、变更账本或 context history；显式 tools override 保持不变。

## 已被否决的方案（不要再引入）

- 拆分 llmActor / llmStreamActor 两个 actor —— 每次请求一个 actor，非流式也走流式累积。
- 给请求 actor 再包一层专用 llm 状态机 —— turn machine 直接 invoke actor 并持有重试/recovery，额外的 machine 层没有任何被消费的状态。
- DDD 领域方法包装（Generation Domain 等）—— 用 format/trait/provider 分层。
- 用一个跨协议 trait 大包承载所有厂商 hooks（旧的 ProtocolTrait）—— 按协议拆分的类型化 trait，由 requester 的请求流水线组合。
- 把 trait 绑定进 format（`createOpenAIFormat(trait)` 闭包，或把 trait hooks 作为 formatRequest 选项传入）—— requester 流水线显式交替调用 format 阶段与 trait hooks，双方只共享中立的 `contract.ts` 类型。
- 函数式 `toWireMessage` / `WireAdapter` 命名 —— adapter interface，命名中不出现 Wire。
- Provider registry / `defineProvider` —— `createProvider` 导出 const。
- 出站时把 system 消息 hoisting 出原位 —— system 消息留在历史原位转换。
- llm 输出 `{message, meta}` 的 Context 对象 —— meta 归 turn 领域，llm 只发事件。
- 在 llm 与 turn 各实现一次 accumulator —— accumulator 只由 turn 持有，随事件流喂入。
- beta 特性无限兜底 —— beta 特性通过 provider 的 extra-params 配置；不存在单独的 `anthropic_beta` 协议。
