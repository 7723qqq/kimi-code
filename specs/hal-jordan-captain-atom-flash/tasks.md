# Tasks — 模型族统一机制（DeepSeek 专属能力合并）

设计见 `design.md`，事实依据见 `requirements.md`。

- T1–T3 为**族表与 tokens 线**（串行依赖）；T4–T5 为**adaptation 线**（串行依赖）；T6 独立可并行。
- 实施档位见 requirements 的 D1；T6 在任何档位下都建议执行（生产可用性依赖它）。
- 所有任务都受"无注释区"约束（agent-core-v2 的 `src/`、`test/`、`scripts/`）。

全局验证命令（各任务验收在此基础上追加）：

```
cd packages/agent-core-v2 && bunx vitest run src/human/test/llm test/_base/utils/tokens.test.ts test/app/agentProfileCatalog
cd packages/agent-core-v2 && bun run lint:imports
cd packages/agent-core-v2 && bun run typecheck
bun scripts/check-no-comments.mjs
```

---

## T1 — 族表（前置，其余任务依赖）

新增 `packages/agent-core-v2/src/human/llm/modelFamily.ts`：`ImageTokenPricing`、`ModelFamilyProfile`、`resolveModelFamily`、`familyAdaptationPrefixes`、匹配归一化（小写、取最后一个 `/` 之后）。
新增 `packages/agent-core-v2/src/llm-adapter/contract/modelFamily.ts`（仅 `export *`）。
首批只登记 `deepseek` 族；不登记 `gpt-4o` / `claude-3.5-sonnet`。

**验收：**
- `resolveModelFamily('deepseek-v3')`、`resolveModelFamily('DeepSeek-V4-Pro')`、`resolveModelFamily('workbuddy/deepseek-v4.1-flash')` 均返回 `id === 'deepseek'`
- `resolveModelFamily('gpt-4o')`、`resolveModelFamily('')`、`resolveModelFamily('my-deepseek-clone')` 的行为按匹配语义确定并在测试中断言（前缀 vs 包含：本计划采用**前缀**，`my-deepseek-clone` 不命中）
- `resolveModelFamily` 对同名不同大小写返回同一结果（幂等）
- 新增 `src/human/test/llm/modelFamily.test.ts`，含上述全部断言
- `bun run lint:imports` 通过（human 内不出现 `#/llm-adapter` 导入）
- `bun scripts/check-no-comments.mjs` 通过

## T2 — tokens 统一（依赖 T1）

新增 `src/human/llm/tokens.ts`：迁移 `llm-adapter/contract/tokens.ts` 的全部实现，`estimateTokensForContentPart` 增可选 `pricing?: ImageTokenPricing`。
`src/llm-adapter/contract/tokens.ts` 改为 `export *`。
`src/human/persist/v2/fold.ts`、`src/human/agent/context-usage.ts` 删内联实现，改导入。

**验收（改前基线 → 改后一致）：**
- 迁移前，对以下三类输入分别采样并记录数值（作为测试 fixture）：纯文本消息、含 `toolCalls` 的消息、含 `image_url` 的消息（三处实现各采一遍）
- 迁移后，`estimateTokensForMessages` / `estimateTokensForMessage` / `estimateTokensForContentPart` 对上述 fixture 的数值与 adapter 版**完全一致**；与 `fold.ts`、`context-usage.ts` 原实现的差异若存在，逐条断言并标注为有意修复
- `packages/agent-core-v2/test/_base/utils/tokens.test.ts` 全部原样通过（含 `MEDIA_TOKEN_ESTIMATE = 2000` 断言）
- `grep -rn "MEDIA_TOKEN_ESTIMATE" packages/agent-core-v2/src` → 仅剩 `human/llm/tokens.ts` 一处定义
- 新增 `src/human/test/llm/tokens.test.ts`，覆盖迁移后的估算与边界（空消息、超长 data URL 不被计为文本）

## T3 — 图片计价接入（依赖 T1、T2）

`estimateTokensForContentPart(part, pricing?)`：`pricing` 缺省时保持 2000；提供且 `part.type === 'image_url'` 时用 `pricing.fallbackTokens`（尺寸版留待后续）。
消费方按可用模型信息传入族参数：`sessionTokenCountingService` 与 `fullCompactionService` 可从 profile 取 `modelAlias`/wireName，经 `resolveModelFamily` 得到 `imagePricing`。

**验收：**
- 新增用例：DeepSeek 族模型 + 图片消息 → 估算值等于 `pricing.fallbackTokens`；非族模型 → 等于 2000
- 未传 `pricing` 的**全部既有调用点**行为不变（`test/_base/utils/tokens.test.ts` 与 `test/agent/tokenCounting/*` 全绿）
- 无尺寸信息时回退值有独立断言（含注释说明接口按尺寸版形状预留）
- `bun run typecheck` 通过

## T4 — adaptation 前缀匹配（依赖 T1）

`modelAdaptations.ts`：`LoadAdaptationInput` 增 `candidates?: readonly string[]`；`loadFrom` 按候选顺序返回**首个存在**的文件；缺省 `candidates = [adaptationFileStem(model)]`（既有行为）。

**验收：**
- 新增用例（`test/app/agentProfileCatalog/modelAdaptations.test.ts`）：
  - 目录含 `deepseek.md` 与 `deepseek-v3.md`，`candidates = ['deepseek-v3', 'deepseek']` → 命中 `deepseek-v3.md`（**最长优先**）
  - 目录仅含 `deepseek.md`，`candidates = ['deepseek-v4-pro', 'deepseek']` → 命中 `deepseek.md`
  - 目录仅含 `gpt-4o.md`，`candidates = ['deepseek-v4-pro', 'deepseek']` → `undefined`（**不借用他族文件**，既有断言继续通过）
  - 未传 `candidates` 时行为与改前逐字节一致
- 既有 5 条 `loadModelAdaptation` 用例与 4 条 `renderAdaptationSection` 用例全部原样通过

## T5 — 匹配输入切 wireName（依赖 T4）

`profileService.ts` 的 `resolveModelAdaptation`：wireName（`tryResolveRawModel()?.name`）的 stem 优先，别名 stem 回退；族前缀接在其后。
门禁（`modelAdaptationsEnabled`）与渲染不动。

**验收：**
- 新增用例：别名 `ds` + wireName `deepseek-v4-pro` → 命中 `deepseek-v4-pro.md`（改前：`ds.md` 不存在 → 不命中）
- 别名 `ds` + wireName 缺失 → 回退别名 stem（不抛错、不误命中他族）
- `KIMI_MODEL_ADAPTATIONS` 未开启时返回 `''`（既有 D2a 行为不变，`adaptlen.test.ts` 通过）
- 提供"改前/改后"对照：同一配置下，`resolveModelAdaptation` 返回值从 `''` 变为含 `# Model Adaptation` 的段落（记录实际长度差）

## T6 — 打包资产可达（独立，可与 T2/T4 并行）

`packages/agent-core-v2/tsdown.config.ts` 增 `copy`，把 `src/app/agentProfileCatalog/model-adaptations/*.md` 复制到 `dist/model-adaptations/`。
若 CLI 链路仍需额外处理（apps/kimi-code 打包时把 agent-core-v2 源码内联），在 apps/kimi-code 的 tsdown 配置中做等价处理——由 T6 的第二步验收决定是否需要。

**验收：**
- `cd packages/agent-core-v2 && bun run build && ls dist/model-adaptations/*.md` → 列出 3 个文件（改前为 0）
- 新增用例：`loadModelAdaptation` 在 `import.meta.dirname` 指向 dist 布局时仍能命中（用显式 `dir` 参数模拟，断言 `dist/model-adaptations` 路径语义正确）
- CLI 侧冒烟：`KIMI_MODEL_ADAPTATIONS=1` 且模型 wireName 为 `deepseek-v3` 时，构建产物中 adaptation 段落可达；若 CLI 打包内联导致该路径不可达，则记录并落到 apps/kimi-code 的配置修复，附验证输出
- 若第二步需要改 apps/kimi-code：`bun run build`（仓库根）后重复上述冒烟

---

## 收尾（全部任务完成后）

- `bunx vitest run`（仓库根，至少 agent-core-v2 项目全绿）
- `cd packages/agent-core-v2 && bun run lint:imports && bun run typecheck`
- `bun scripts/check-no-comments.mjs`
- 变更集：按仓库惯例补 `.changeset/*.md`（`@moonshot-ai/agent-core-v2` patch；若对外可见行为变化达 minor 则 minor）
- 若发现 `kosong` 侧存在同名能力的**行为分叉**（如 reasoning 方言默认值不一致），只**记录**到 spec 的 progress 文档，不在本计划内修改 kosong

## 决策记录（执行时需回填）

- D1 档位选择：全量 / 核心 / 最小
- D2 计价深度：族级回退（推荐）或尺寸精确
- D3 资产方式：tsdown copy（推荐）或源码内联
