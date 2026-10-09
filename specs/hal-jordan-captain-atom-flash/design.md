# Design — 模型族统一机制（DeepSeek 专属能力合并）

需求与事实依据见 `requirements.md`（F1–F12）。本文件给出统一设计、落点、顺序与否决方案。

## 统一设计：一个族表，四个消费方

核心是**单一事实源**：`ModelFamilyProfile` 表。四个落点都从它取"这个模型属于哪个族"，不再各自维护模式匹配。

```
                      ┌───────────────────────────────┐
                      │  human/llm/modelFamily.ts     │   纯函数、纯数据
                      │  resolveModelFamily(name)     │   无 I/O、无 DI
                      │  ModelFamilyProfile[]         │
                      └───────────┬───────────────────┘
                                  │ 经 llm-adapter/contract/modelFamily.ts re-export
      ┌───────────────┬───────────┼───────────────┬─────────────────┐
      ▼               ▼           ▼               ▼                 ▼
 能力判定          图片计价      adaptation 匹配   行为层消费       提示词层消费
 (provider/        (tokens.ts    (modelAdaptations (无新增调用点：  (profileService
  definition.ts     family 参数)  .ts 前缀匹配)      能力/缓存/effort    .ts wireName
  的 capability)                                     已由既有链路覆盖)   传入匹配)
```

**行为层与提示词层如何合并为一个机制**：两层的**判定**共用族表与同一匹配语义（`resolveModelFamily`）；两层的**生效门禁**不同——行为层（能力、token 估算、计价）默认生效；提示词层（adaptation 注入）保持 `KIMI_MODEL_ADAPTATIONS` opt-in（F10）。这是有意的：行为层是可验证的代码行为，提示词层目前承载无出处 prose（requirements 已排除其内容产出）。

### 数据结构

```ts
// human/llm/modelFamily.ts（新增；无注释区，仅导出与实现）
export interface ImageTokenPricing {
  readonly patchPx: number;            // 14
  readonly downsampleRatio: number;    // 3
  readonly scaleUpFloorPx: number;     // 544
  readonly tokenCap: number;           // 1024
  readonly fallbackTokens: number;     // 无尺寸信息时的回退值
}

export interface ModelFamilyProfile {
  readonly id: string;                 // 'deepseek'
  readonly match: readonly string[];   // ['deepseek', 'deepseek-', ...] 前缀
  readonly adaptationPrefixes: readonly string[];  // 供 adaptation 文件名匹配
  readonly reasoningKeys?: readonly string[];      // 方言优先级（默认沿用既有表）
  readonly imagePricing?: ImageTokenPricing;
}

export function resolveModelFamily(name: string): ModelFamilyProfile | undefined;
export function familyAdaptationPrefixes(name: string): readonly string[];
```

**匹配语义（两处共用同一实现）**：

```
normalize(name) = 小写；取最后一个 '/' 之后的部分（去 provider 前缀）
resolveModelFamily: 按 match 前缀最长者胜出；同长度按声明顺序
```

首批只登记 `deepseek` 族，`imagePricing` 取 DeepSeek 公开视觉计费口径（14px patch、3:1 下采样、544 下限、1024 上限；`fallbackTokens = 1024` 为保守上界）。`gpt-4o` / `claude-3.5-sonnet` **不登记**——它们在 adaptation 上保持精确匹配（requirements 范围外）。

## 模块与文件落点

### 新增

| 文件 | 内容 | 约束 |
| --- | --- | --- |
| `packages/agent-core-v2/src/human/llm/modelFamily.ts` | 族表 + `resolveModelFamily` + 匹配归一化 | 纯内核，不导入 `#/llm-adapter`、v2 域（F8）；无注释（F9） |
| `packages/agent-core-v2/src/human/llm/tokens.ts` | 从 `llm-adapter/contract/tokens.ts` 迁入的实现 + `estimateTokensForContentPart(part, pricing?)` | 同上；`WeakMap` 缓存保持不变 |
| `packages/agent-core-v2/src/llm-adapter/contract/modelFamily.ts` | `export * from '#human/llm/modelFamily'` | 仅 re-export |
| `packages/agent-core-v2/src/human/test/llm/modelFamily.test.ts` | 族判定、前缀优先级、非命中 | — |
| `packages/agent-core-v2/src/human/test/llm/tokens.test.ts` | 迁移后的估算与计价用例 | — |

### 改造

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `src/llm-adapter/contract/tokens.ts` | 改为 `export * from '#human/llm/tokens'` | 消除 F2/F3 的重复实现；对外符号不变 |
| `src/human/persist/v2/fold.ts:12,122-154` | 删内联 `estimateTokens*`/`MEDIA_TOKEN_ESTIMATE`，改导入 `human/llm/tokens.ts` | 同一内核内导入，不违反边界 |
| `src/human/agent/context-usage.ts:6,25-55` | 同上 | 同上 |
| `src/app/agentProfileCatalog/modelAdaptations.ts` | 新增前缀匹配；`loadModelAdaptation` 增 `candidates: readonly string[]` 输入；`adaptationFileStem` 保留 | 精确匹配仍是第一优先（保持既有测试语义） |
| `src/agent/profile/profileService.ts:883-895` | 匹配输入改为 `wireName` 优先、`modelAlias` 回退；`candidates = [stem, ...familyAdaptationPrefixes]` | `tryResolveRawModel()?.name` 可得（F11） |
| `packages/agent-core-v2/tsdown.config.ts` | 增 `copy: [{ from: 'src/app/agentProfileCatalog/model-adaptations', to: 'dist/model-adaptations' }]` | 修复 F4；与 `adaptationDirectoryCandidates()[0]` 对齐 |
| `src/llm-adapter/provider/provider-definition.ts`（消费方） | 新增 provider 的 `capability` 钩子可委托 `resolveModelFamily` | 不改 `ProtocolBinding` 类型，仅新增可选 provider 定义（见 T6，可选） |

### 关键接口契约

```ts
// modelAdaptations.ts
export interface LoadAdaptationInput {
  readonly model: string;
  readonly candidates?: readonly string[];   // 新增：按序尝试的 stem 列表
  readonly log?: ILogger;
  readonly dir?: string;
}
```

匹配顺序：`candidates`（wireName 的 stem 在前，别名 stem 其次，族前缀依次在后）→ 目录内**首个存在**的文件胜出；无候选命中时返回 `undefined`（保持"不借用他族文件"的既有语义，`modelAdaptations.test.ts:67` 的断言不变）。

```ts
// human/llm/tokens.ts
export function estimateTokensForContentPart(part: ContentPart, pricing?: ImageTokenPricing): number;
```

`pricing` 缺省时保持 `MEDIA_TOKEN_ESTIMATE = 2000`（既有行为，测试 `test/_base/utils/tokens.test.ts` 全部继续通过）。提供 `pricing` 且 part 为 `image_url` 时，无尺寸信息回退 `pricing.fallbackTokens`。

## 依赖与实施顺序

```
T1 族表（human/llm/modelFamily.ts + adapter re-export）
   │
   ├─► T2 tokens 统一（human/llm/tokens.ts，三处收敛）      ← 依赖 T1（pricing 类型）
   │      │
   │      └─► T3 计价接入（estimator 支持 pricing；调用点传族参数）  ← 依赖 T1、T2
   │
   ├─► T4 adaptation 前缀匹配（modelAdaptations.ts）        ← 依赖 T1（前缀来源）
   │      │
   │      └─► T5 匹配输入切 wireName（profileService.ts）    ← 依赖 T4
   │
   └─► T6 资产可达（tsdown copy）                            ← 独立，可并行
```

- **前置**：T1（其余全部依赖它的类型或前缀语义）。
- **可并行**：T6 与 T2/T4 无依赖；T4 与 T2 无相互依赖（都只依赖 T1）。
- **必须串行**：T1→T2→T3；T4→T5。
- **T6 的独立价值**：即使 T4/T5 不做，`KIMI_MODEL_ADAPTATIONS=1` 的生产可用性也依赖它（当前 dist 场景永久失效，F4）。

## 复用 / 改造 / 替换关系

| 既有实现 | 关系 | 说明 |
| --- | --- | --- |
| `human/llm/requester/bases/openai/capability.ts` 的 `getOpenAILegacyModelCapability` | **保留，不改** | 族表是新增的第二层；T6 可选地让 provider 定义优先于 base 默认值（既有 hook 已支持） |
| `ProtocolBinding.capability`（F7） | **复用** | 不改类型；族表作为其可选实现来源 |
| `adaptationFileStem` / `stripGeneratedHeader` / `renderAdaptationSection` | **复用** | 匹配放宽只改"候选列表构造"，渲染与门禁不动 |
| `kosong/src/tokens.ts`、`kosong/src/providers/capability-registry.ts` | **不动** | requirements 明确排除；v2 是主路径（F1） |
| `llm-adapter/contract/tokens.ts` 的独立实现 | **替换为 re-export** | 消除重复；对外 API 不变 |
| `fold.ts` / `context-usage.ts` 的内联估算 | **替换为导入** | 消除三份拷贝 |
| `modelAdaptations.test.ts` 既有断言 | **保留 + 扩展** | 精确匹配优先、不借用他族文件的语义必须继续通过 |

## 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| **族表放 kosong，v2 复用** | kosong 在 v2 被删除且导入被 lint 拦截（F1）；v2 需要独立实现，跨包同步成本高于收益 |
| **族表放 `llm-adapter/contract/`（只此一处）** | 会把纯数据放进兼容边界，`human` 内部的 tokens 估算无法导入（F8 方向限制：human 不能导入 adapter） |
| **`?raw` 静态导入 adaptation 文件** | 增删文件必须改代码；且族级回退需要"文件不存在时静默跳过"，静态导入做不到 |
| **一次性实现尺寸精确计价（14px/3:1/544/1024）** | `ContentPart.imageUrl` 无尺寸字段，media 层也不存尺寸；需要先引入尺寸数据源（独立工程）。本计划用族级回退值，接口按尺寸版形状预留 |
| **把 `KIMI_MODEL_ADAPTATIONS` 一并默认开启** | 无出处 prose 会扩散到全部会话；既有 spec `maxima-creeper-white-tiger` 已定 D2(a) opt-in，本计划不推翻 |
| **在 `profileService` 内联族判定** | 会让 tokens 估算与 adaptation 各有一份匹配逻辑，正是本次要消除的散点 |
| **给 `Model` 接口新增 `family` 字段** | `Model` 是纯数据且被大量快照/序列化路径消费；族判定是纯函数，调用点现算即可，避免污染契约 |

## 风险

1. **匹配放宽导致陈旧建议外溢**（`deepseek-v3.md` 命中 `deepseek-v4` 会话）：缓解——族级文件与版本级文件分开命名（`deepseek.md` vs `deepseek-v3.md`），前缀按**最长优先**，且提示词层仍 opt-in。
2. **tokens 统一改变既有数值**：三处内联实现与 adapter 版在边界行为上可能有差异（如 `toolCalls.arguments` 缺省、`role` 计数）。缓解——T2 先写"改前基线"测试（对既有三处分别采样），再迁移并断言数值一致；不一致处记录为**有意修复**并单独断言。
3. **tsdown `copy` 在 CLI 打包链路的行为**：CLI 侧可能仍以源码解析 workspace 包。缓解——T6 的验收在**两层**都检查：`agent-core-v2/dist/model-adaptations/` 存在，且 CLI 场景（`KIMI_MODEL_ADAPTATIONS=1` + 非命中族）行为可测。
4. **`wireName` 与别名不一致时的匹配抖动**：wireName 优先是**有意**选择（配置别名是用户自取）；但 `Model.name` 缺失时回退别名的路径必须有测试。
