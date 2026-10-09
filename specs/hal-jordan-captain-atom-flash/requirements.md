# Requirements — 模型族统一机制（DeepSeek 专属能力合并）

## 目标

把上一轮识别的四类"DeepSeek 专属能力"落点**合并为一套统一实现**，以"模型族特征表"为单一事实源：

1. 按模型名模式分派的行为特征表（专属通道的判定层）
2. 图片 token 计价 estimator
3. `model-adaptations` 前缀匹配与 `deepseek-*` 专属通道
4. 行为层（默认生效）/ 提示词层（opt-in 门禁）两层分离

合并的要求是：四个落点共享同一套"这个模型属于哪个族"的判定，而不是各自维护独立的模式匹配。行为层与提示词层的生效门禁保持不同（见下），但族判定与匹配语义必须一致。

## 受众

维护 v2 LLM 栈（`packages/agent-core-v2` 的 `human/llm`、`llm-adapter`、`app/agentProfileCatalog`）的人。需要知道：改哪些文件、以什么顺序、每步怎么验、以及哪些东西被有意排除。

## 调研结论（决定设计的既有事实）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | **v2 是活跃引擎**；kosong 在 v2 内已被删除，边界脚本禁止导入 | `packages/agent-core-v2/scripts/check-import-boundaries.mjs:15,137-141`（"the kosong kernel is deleted"）；`packages/agent-core-v2/src/kosong/` 不存在 |
| F2 | kosong 与 v2 存在**平行实现且已漂移** | `kosong/src/providers/capability-registry.ts` ↔ `agent-core-v2/src/human/llm/requester/bases/openai/capability.ts`；`kosong/src/tokens.ts` ↔ `llm-adapter/contract/tokens.ts`（后者是独立拷贝，非 re-export，与 `docs/en/llm.md` 所称的 "thin re-export" 不符） |
| F3 | token 估算在 v2 内有**三份拷贝** | `llm-adapter/contract/tokens.ts:62`、`human/persist/v2/fold.ts:12`、`human/agent/context-usage.ts:6`（后两者各自内联 `MEDIA_TOKEN_ESTIMATE = 2000` 与私有实现） |
| F4 | **打包后 adaptation 资产不可达**：`dist/` 不含 `.md`，`adaptationDirectoryCandidates()` 的三个候选在 dist 场景全部落空 | `find packages/agent-core-v2/dist -name '*.md'` → 0 个；`modelAdaptations.ts:10-17` |
| F5 | 模型有两个名字：`Model.id` = 配置别名（`config.toml` 的 key），`Model.name` = wireName（`model.name ?? model.model`） | `catalog-service.ts:306-390`（`id` 与 `wireName`） |
| F6 | 现有 adaptation 匹配输入是**别名**、规则是**文件名精确相等** | `modelAdaptations.ts:19-26,64`；`profileService.ts:886-889` |
| F7 | v2 已有**按模型名分派的既有挂载点** | `human/llm/provider/definition.ts` 的 `ProtocolBinding.capability?: (modelName) => ModelCapability`；`bases/openai/requester.ts:266` 使用 `getOpenAILegacyModelCapability` |
| F8 | 层级约束：`human/` 是纯内核（禁止导入 `#/llm-adapter` 与 v2 域）；非 adapter 的 v2 代码导入 human 实现受 `HUMAN_VOCABULARY` 白名单限制；`llm-adapter` 是唯一兼容边界 | `check-import-boundaries.mjs:53-76,155-197` |
| F9 | `agent-core-v2` 是**无注释区**（`src/`、`test/`、`scripts/`） | `scripts/check-no-comments.mjs`（PACKAGES 含 agent-core-v2） |
| F10 | 提示词层已 opt-in 门禁：默认不注入，`KIMI_MODEL_ADAPTATIONS=1` 才读取 | `profileService.ts:884`；`modelAdaptations.ts:114-118` |
| F11 | `Model` 的 wireName 在 profile 层可得 | `profileService.ts:744-747`（`tryResolveRawModel()?.name`） |
| F12 | `?raw` 构建插件可在打包时内联文本资产；`system.md` 已用该模式 | `build/raw-text-plugin.mjs`；`profile-shared.ts:12` |

## 范围

### 纳入

- **模型族特征表**：新增纯函数模块（族判定 + 首批 `deepseek` 族），供行为层与提示词层共用。
- **图片 token 计价**：族携带计价参数；估算入口支持族感知 estimator；v2 内三份 token 估算统一到一份实现（adapter 改 re-export，human 两处改导入）。
- **adaptation 匹配**：新增"精确 → 声明族最长前缀"匹配规则；匹配输入改为 wireName 优先、别名回退；门禁保持 opt-in。
- **打包资产可达性**：修复 `dist/` 下 adaptation 文件不可达（否则提示词层在生产永久失效）。
- **验证与观测**：上述各点的可执行验收（见 tasks.md）。

### 明确排除

- **不改 kosong**。v2 是 CLI 主路径，kosong 在 v2 被删除（F1）；kosong 侧存在平行实现是历史事实（F2），本次不追平、不同步、不双写。
- **不新增真实 adaptation 文件内容**。`deepseek.md`（族级）的内容产出涉及"无出处 prose"，不在本计划；机制用测试夹具验证。
- **不实现 `probe --write-adaptation`**，不解决 adaptation 数字的来源可信问题（既有 spec `maxima-creeper-white-tiger` 已记录该问题；本计划只解决"匹配与可达"）。
- **不引入 DSH 的 `systemPromptUpdate: in-history` 语义**（上一轮已论证：kimi-code 的动态内容本就追加在历史；且该语义是 DeepSeek 端点专有）。
- **不实现 DSH 的请求扩展注册表（prepare/accept 语义）**（现有 `generationKwargs` 逃生通道足够）。
- **不精确化图片计价所需的尺寸数据源**（当前 `ContentPart` 的 `image_url` 不含尺寸；首批用族级回退值，接口预留尺寸参数）。
- **不改 `gpt-4o` / `claude-3.5-sonnet` 的匹配行为**（非声明族保持精确匹配）。

## 需要决策的点

**D1 — 实施档位。** 见 tasks.md 的 T1–T6 分组：
- 全量（T1–T6）：族表 + tokens 统一 + 计价接入 + adaptation 匹配 + 资产修复
- 核心（T1、T4、T5）：族表 + adaptation 匹配 + 资产修复；tokens 统一与计价延后
- 最小（T4、T5）：仅 adaptation 前缀匹配与资产修复

**D2 — 图片计价深度。**
- (a) 族级回退值（`fallbackTokens`）：接口与接入齐备，数值粗粒度，无尺寸依赖
- (b) 尺寸精确（14px patch / 3:1 / 544 下限 / 1024 上限）：需要先解决尺寸数据源（media store 或 data URL 解码），工程量与风险显著更大
- 推荐 (a)；接口按 (b) 的形状设计（`imageTokensFor(pricing, dimensions?)`），(b) 作为独立后续。

**D3 — 资产方式。**
- (a) 构建时复制 `src/app/agentProfileCatalog/model-adaptations/*.md` → `dist/model-adaptations/`（现有候选路径第一项即命中）
- (b) 源码内联（`?raw` 静态导入）：增删文件必须改代码，弃
- 推荐 (a)。

## 验收总则

全局命令（各任务的验收以此为基础）：

```
bunx vitest run packages/agent-core-v2/src/human/test/llm packages/agent-core-v2/test/app/agentProfileCatalog
cd packages/agent-core-v2 && bun run lint:imports
bun scripts/check-no-comments.mjs
cd packages/agent-core-v2 && bun run build && ls dist/model-adaptations/*.md
```

- 无注释区（F9）内的新增代码不得含任何注释（lint 抑制指令除外）。
- `human/` 内的新增模块不得导入 `#/llm-adapter` 或 v2 域（F8）；app 层消费族表必须经 `llm-adapter` 的 re-export。
- 行为变更（tokens 统一、匹配放宽）必须先有"改前基线"断言，再验证改后行为。
