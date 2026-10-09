# Progress — 模型族统一机制（DeepSeek 专属能力合并）

执行 `tasks.md`（全量档 T1–T6）。设计见 `design.md`，事实依据见 `requirements.md`。

**状态：T1–T6 全部完成。**

---

## T1 — 族表 ✅

**交付：**
- 新增 `packages/agent-core-v2/src/human/llm/modelFamily.ts`：`ImageTokenPricing`、`ModelFamilyProfile`、`normalizeModelName`、`resolveModelFamily`、`familyAdaptationPrefixes`、`imagePricingForModel`。首批登记 `deepseek` 族（前缀匹配、最长胜出）。
- 新增 `packages/agent-core-v2/src/llm-adapter/contract/modelFamily.ts`：仅 `export * from '#human/llm/modelFamily'`。
- 新增 `packages/agent-core-v2/src/human/test/llm/modelFamily.test.ts`：8 条用例。

**验收证据：**
- `bunx vitest run src/human/test/llm/modelFamily.test.ts` → 8 passed
- `bun scripts/check-no-comments.mjs` → OK
- `bun run lint:imports` → `check-import-boundaries: OK`；`check-deep-imports: OK`
- 断言要点：`deepseek-v3` / `DeepSeek-V4-Pro` / `workbuddy/deepseek-v4.1-flash` 命中；`gpt-4o`、`my-deepseek-clone`、空串不命中（**前缀**语义，非包含）

## T2 — tokens 统一 ✅

**交付：**
- 新增 `packages/agent-core-v2/src/human/llm/tokens.ts`：迁移 adapter 版实现，估算函数增可选 `pricing?: ImageTokenPricing`；`pricing` 缺省时保持 `MEDIA_TOKEN_ESTIMATE = 2000` 与 WeakMap 记忆化。
- `src/llm-adapter/contract/tokens.ts` 改为 `export *`（消除独立拷贝）。
- `src/human/persist/v2/fold.ts`、`src/human/agent/context-usage.ts` 删内联估算，改导入统一实现。
- 新增 `src/human/test/llm/tokens.test.ts`：13 条用例。

**改前基线（三处实现采样，脚本 `/tmp/t2-baseline/baseline.mjs`）：**

| 用例 | adapter | fold.ts | context-usage |
| --- | --- | --- | --- |
| 纯文本 | 4 | 4 | 4 |
| toolCalls（含 null arguments） | 16 | 16 | **13** |
| 图片 | 2001 | 2001 | 2001 |
| 混合 | 2015 | 2015 | **2014** |

**有意修复（已单独断言）：**
1. 非 assistant 角色的 `toolCalls` 也计入（旧 `context-usage` 仅计 assistant）。
2. `arguments: null` 按 `JSON.stringify(null)` 计入（与 adapter 版一致）。
   → 统一后 `context-usage` 路径对 toolCalls 消息的估算**上升**，方向更保守且与 adapter 版一致。

**验收证据：**
- 全量 `bunx vitest run` → **437 files / 7773 passed | 15 skipped**
- `grep -rn "MEDIA_TOKEN_ESTIMATE" src` → 仅 `human/llm/tokens.ts` 一处定义
- `test/_base/utils/tokens.test.ts`、`test/llm-adapter/contract/usage-tokens.test.ts` 原样通过

## T3 — 图片计价接入 ✅

**交付：**
- `IAgentProfileService.getModelWireName()` 新增；`AgentProfileService` 实现（`tryResolveRawModel()?.name`）。
- `ISessionTokenCountingService` 的 `estimateMessage/estimateMessages/requestSize` 增可选 `pricing`，服务实现透传。
- `fullCompactionService`（5 处调用点）与 `microCompactionService`（1 处）按 wireName 解析族 pricing 并传入。
- `imagePricingForModel` 签名放宽为接受 `string | undefined`。
- 新增 `test/agent/tokenCounting/imagePricing.test.ts`：5 条用例（别名 `ds` → wireName `deepseek-v4-pro` → 族计价全链路）。

**验收证据：**
- `bunx vitest run test/agent/tokenCounting test/agent/contextMemory test/agent/fullCompaction test/agent/profile` → 全绿
- `bun run typecheck` → 通过
- 族模型图片按 `fallbackTokens`（1024）计价、非族模型保持 2000；未传 `pricing` 的既有调用点行为不变

**约定偏差（记录）：** tasks.md 的验收项写"含注释说明接口按尺寸版形状预留"，但 agent-core-v2 是无注释区（`check-no-comments.mjs` 强制），代码注释会直接失败。以 `ImageTokenPricing` 的字段形状（`patchPx` / `downsampleRatio` / `scaleUpFloorPx` / `tokenCap` 已声明、当前仅用 `fallbackTokens`）承载该意图，并在本文件记录。

## T4 — adaptation 前缀匹配 ✅

**交付：**
- `modelAdaptations.ts`：`LoadAdaptationInput` 增 `candidates?: readonly string[]`；`loadFrom` 按候选顺序取**首个存在**的文件；缺省行为与改前逐字节一致。
- 大小写不敏感匹配改用 `Map<lowerName, realName>`（避免用小写名去读真实大小写文件名的路径错误）。
- 测试新增 6 条候选列表用例 + 3 条候选目录用例。

**验收证据：**
- `bunx vitest run test/app/agentProfileCatalog/modelAdaptations.test.ts` → **26 passed**
- 关键断言：`['deepseek-v3','deepseek']` 命中版本文件（最长优先）；仅 `deepseek.md` 时回退族文件；仅 `gpt-4o.md` 时返回 `undefined`（**不借用他族文件**）；未传 `candidates` 时行为不变

## T5 — 匹配输入切 wireName ✅（含既有缺陷修复）

**交付：**
- `resolveModelAdaptation(pendingModelAlias?)`：wireName 优先、别名回退、族前缀接后（`adaptationCandidates` 去重）。
- **修复既有缺陷**：`bind()` 在派发 `ProfileBind` **之前**构建系统提示词，此时 `profileState.modelAlias` 尚未写入 → `resolveModelAdaptation` 拿到 `undefined` 直接返回空。**结论：opt-in 开启时，绑定路径上 adaptation 从未注入过**（此前只可能通过后续 `applyProfile` 路径注入）。修法：`buildSystemPromptContext(profile, { pendingModelAlias: alias })`，`bind()` 显式传入待绑定别名。
- 新增 `test/agent/profile/adaptation-wire-name.test.ts`：3 条用例（wireName 命中 / opt-in 关闭不注入 / 无版本文件时不误命中）。

**验收证据：**
- `bunx vitest run test/agent/profile/adaptation-wire-name.test.ts` → 3 passed
- 别名 `ds` + wireName `deepseek-v3` → 提示词含 `# Model Adaptation: deepseek-v3`（改前：不命中）

**偏差（记录）：** tasks.md 的验收项写"别名 `ds` + wireName `deepseek-v4-pro` → 命中 `deepseek-v4-pro.md`"，但该 md 文件不存在（requirements 明确排除新增适配文件内容）。改用 `deepseek-v3`（已发布的文件）验证同一链路——wireName 优先于别名的语义等价，且"无版本文件时不误命中"单独有断言。

## T6 — 打包资产可达 ✅

**交付：**
- `packages/agent-core-v2/tsdown.config.ts` 增 `copy`：`src/app/agentProfileCatalog/model-adaptations` → `dist/`。
- `modelAdaptations.ts` 的 `adaptationDirectoryCandidates(moduleDir?)` 改为**向上有界搜索**（4 层）+ 保留原源码布局候选；导出以便测试。
- `apps/kimi-code/tsdown.config.ts` 增 `copy` → `dist/chunks/`（CLI 把 agent-core-v2 **内联**进 bundle，`import.meta.dirname` 指向 `dist/chunks/`）。
- 新增 `test/dist-layout-probe.test.ts`：3 条用例（`skipIf` 保护，无 dist 时跳过 2 条）。

**验收证据：**
- `bun run build`（agent-core-v2）→ `dist/model-adaptations/{claude-3.5-sonnet,deepseek-v3,gpt-4o}.md`（改前 0 个）
- `bun run build`（apps/kimi-code）→ `dist/chunks/model-adaptations/*.md`
- CLI 场景候选路径模拟：第一候选 `dist/chunks/model-adaptations` **HIT（3 files）**；改前三个候选全部落空
- `bunx vitest run test/dist-layout-probe.test.ts` → 3 passed（无 dist 时 1 passed | 2 skipped）

## 收尾验证 ✅

| 检查 | 结果 |
| --- | --- |
| `agent-core-v2` 全量测试 | **437 files / 7773 passed \| 15 skipped** |
| `node-sdk` 测试 | 27 files / 271 passed |
| `kap-server` 测试 | 75 files / 1416 passed |
| `apps/kimi-code` 测试 | 270 files / 4215 passed \| 4 skipped |
| `check-no-comments.mjs` | OK（2003 files） |
| `lint:imports`（agent-core-v2） | boundaries OK / deep-imports OK |
| `typecheck`（agent-core-v2 / node-sdk / kap-server / klient） | 全部通过 |
| changeset | `.changeset/model-family-unification.md`（agent-core-v2 / kimi-code / kimi-code-sdk，patch） |

## 过程中的额外发现（未在本计划内修改）

- **microCompaction 测试的 profile stub 需补 `getModelWireName`**：`test/agent/microCompaction/microCompactionService.test.ts` 的局部 stub 是部分替身，加接口方法后 7 条用例报 `not a function`；已补 `getModelWireName: () => 'test-model'`。这提示：**给 `IAgentProfileService` 加方法会影响以部分替身 stub 它的测试**（全仓库 48 个文件引用该接口，其中多数用 `as unknown as` 或局部对象）。
- **kosong 侧存在平行实现**（`kosong/src/tokens.ts`、`kosong/src/providers/capability-registry.ts`），按 requirements 的排除项**未改动**。若将来 kosong 仍需维护，需单独评估是否同步族表。
- **适配文件的内容仍无出处**：本次只解决"匹配与可达"，三个 md 的内容可信问题（既有 spec `maxima-creeper-white-tiger` 的 D2a）仍未解决，`probe --write-adaptation` 未实现。
- **族级文件尚未提供**：`deepseek.md` 未创建（requirements 明确排除内容产出），因此 `deepseek-v4-pro` 当前不命中任何 adaptation；机制已就绪（T4 测试用夹具验证）。
