# Progress — 提示词治理与模型适配重构

执行 `specs/daredevil-john-stewart-quake/tasks.md`（Task 1–7）。设计见 `design.md`，需求见 `requirements.md`。

**状态：Task 1–7 全部实现完成。focused 检查、optimizer 测试、typecheck、lint 通过；`check:boundaries` 与全仓 `bun run test` 的失败均为既有问题，逐条记录在「外部阻塞与既有失败」。**

Changeset：`.changeset/prompt-governance-contract.md`、`.changeset/prompt-optimizer-rendered-eval.md`（按 `CONVENTIONS.md` 的「Prompt text is behavior」要求写明受众、被删句子的接管者与命名的损失）。

## 最终校验

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| agent-core 指定套件 | `bun test --isolate test/app/agentProfileCatalog test/features/deepseekAdaptation test/agent/agentsMdReminder`（在 `packages/agent-core-v2`） | 208 pass / 1 skip / 0 fail（8 files） |
| prompt-optimizer 单元测试 | `cd scripts/prompt-optimizer && bun test` | 173 pass / 0 fail（18 files） |
| agent-core typecheck | `bunx tsc -p packages/agent-core-v2/tsconfig.json --noEmit` | 0 错 |
| import 边界 | `bun run check:boundaries` | **失败，14 处，既有**：全部在 `packages/product` 与 `packages/kap-server`（见下文「外部阻塞与既有失败」） |
| 无注释区 | `bun run check:no-comments` | OK（2076 files） |
| 提示词所有权 | `bun run check:prompt-ownership` | OK |
| 仓库 typecheck | `bun run typecheck` | 通过：所有包 `Exited with code 0`（先修复了 node-sdk 测试里 9 处 `vi` 残留） |
| 仓库 lint | `bun run lint` | 0 errors / 14232 warnings（warning 均为仓库既有规则输出） |
| 全仓测试 | `bun run test` | **失败**：6 个包 exit 1，全部为既有失败（WIP 占用锁/移植改动与 bun 测试基础设施），无一位于本次改动路径；逐包结果见下 |

## Task 1 — 行为契约与投递模型 ✅

**交付**
- 新增 `packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts`：六个稳定 core id（`authority_and_untrusted_content`、`act_and_verify`、`tools_and_repository_context`、`safety_and_scope`、`failure_and_partial_progress`、`communication`），每个 clause 带 `anchor`（测试与报告的稳定定位串）、`full` 文本、可选的 `minimal` 文本；`renderFullBehaviorContract` / `renderMinimalBehaviorContract` / `behaviorContractProjectionFor` 返回文本 + `ContractDelivery[]`（`system` / `reminder` / `intentionally_omitted`）。
- `profile-shared.ts` 接线：`renderSystemPromptResult` 按 `promptShapeForModel` 选择投影并注入 `${behavior_contract}`；新增 `contractDelivery`、`valueDelivery`（逐变量分类，带 reason）、`warnings`（${name} 未解析即 `unresolved_variable`）；`renderPromptTemplateResult` 同样给出 warnings，并合并 `base_prompt` 的投递元数据。
- `SystemPromptRenderResult` 保持向后兼容：三个新字段均为可选（`packages/agent-core-v2/src/app/agentProfileCatalog/agentProfileCatalog.ts`）。
- `minimal` 投影只承载两条 core clause，其余四条声明为 reminder 投递（有 curated adaptation 时）或 `intentionally_omitted`（无通道时），并在文本中留下稳定 handoff 串。

**验收证据**
- `bun test --isolate test/app/agentProfileCatalog/profile-shared.test.ts` → 61 pass / 0 fail（新增 5 条契约/投递用例 + 既有用例）。
- `bunx tsc -p packages/agent-core-v2/tsconfig.json --noEmit` → 0 错。
- 未解析占位符用例断言：`renderPromptTemplateResult('known=${cwd} unknown=${mystery}')` 的文本保留 `${mystery}`，并产生 `{ code: 'unresolved_variable', name: 'mystery' }`。

**偏差**
- 规格中的 `bunx vitest run …` 在本仓库不可执行：所有测试导入 `bun:test`，vitest 报 `Cannot find package 'bun:test'`（已实测）。改用等价的 `bun test --isolate <files>`；这是环境/工具链偏差，不改变被测行为。

## Task 2 — 项目与全局指令所有权 ✅

**交付**
- 根 `AGENTS.md`：明确「只有本文件以 `${agents_md}` 自动注入；`DEVELOP.md`/`CONVENTIONS.md`/`CONTRIBUTING.md` 按需读取」，声明三层文件的单一所有权，并指向 `behaviorContract.ts`；把原「`system.minimal.md` 是 minimal 会话收到的全部提示词」改写为「入口提示词 + reminder 双通道」。
- `DEVELOP.md`：新增 `## Instruction Ownership and Precedence`（注入与否、优先级、子目录 DEVELOP 的收窄语义、用户级/`SYSTEM.md` 覆盖不属于仓库）。
- 新增 `scripts/check-prompt-ownership.mjs` + `check:prompt-ownership`：校验 AGENTS→DEVELOP 链接、不得声称 DEVELOP 被自动注入、DEVELOP 拥有所有权章节、六个 core id 都在契约模块中。
- 本机全局指令 `C:/Users/Administrator/.kimi-code/AGENTS.md`（仓库外，未提交）：
  - 编辑前私有备份：`C:/Users/Administrator/AppData/Local/Temp/kimi-prompt-governance-20261023110900/AGENTS.md.bak`；
  - 编辑前：10158 B、15 个二级标题、69 行正文、57 条 bullet；
  - 编辑后：9951 B（< 32 KiB）、8 个契约域标题（Authority and execution / Execution / Verification / Safety / Windows shell / Tool use / Communication / Other standing rules）、正文 69 行逐行保留、0 重复 bullet、0 密钥样式命中；
  - 正文只由脚本在内存中处理与比对，未进入仓库、报告或日志，也未读取其他 home 文件。

**验收证据**
- `bun run check:prompt-ownership` → OK。
- 私有校验脚本输出仅含计数与标题名（`bytes/headings/missingRequiredHeadings/duplicateBullets/sensitivePatternHits`），无正文。
- `rg "Kimi Code Personal Core Prompt" .` 在仓库内零命中（全局正文未落入仓库）。

**偏差**
- 因「正文不写日志」的硬约束，全局文件的重排是**按标题归并 + 正文逐行保真**，没有做逐句改写；语义删减会需要把正文读入模型上下文，属被禁止的操作。这一点在「证据分级」中记为未做的语义优化，而不是已完成。

## Task 3 — full / minimal 提示词资产 ✅

**交付**
- `system.md`：新增 `# Working contract`（`${behavior_contract}`）；删除与新契约重复的 `# Risky actions` 段、「Do what was asked」句、`# Tool use` 中已被契约覆盖的两句、`# Communicating` 中重复的「Match the user's language」；保留运行时专属内容（工具机制、Coding、turn-end、scope-of-run、context、environment、project information）。
- `system.minimal.md`：重写为 persona + cwd + `${role_additional}` + `# Working contract`（两条核心 + handoff），不再复制 v4.1 的三段操作提示（它们归 reminder）。
- project / plugin 文本框继续以 “reference data” 表述，并由测试锁定。

**验收证据**
- `bun test --isolate test/app/agentProfileCatalog` → 126 pass / 0 fail。
- fixture 渲染：full 6/6 core 全部 `system`、0 unresolved、0 warnings；deepseek 2 `system` + 4 `reminder`、0 unresolved、0 warnings。
- 「非 DeepSeek 字节等同 full 基线」用例继续通过（`leaves every other model on the shipped template, byte for byte`）。
- 去重用例：同一条规则句在 full 渲染中只出现一次（`toHaveLength(2)` 的 split 断言）。

**偏差**
- `test/app/agentProfileCatalog/deepseekAdaptation.test.ts` 的「minimal 里也写着三段 v4.1 提示」断言被改为「minimal 只保留 handoff，三段由 reminder 承载」。这是本 Task 有意改变的行为（需求 3：minimal 不得复制完整 prompt），改动理由已写进用例名与断言。

## Task 4 — DeepSeek 适配的渲染与生命周期分层 ✅

**交付**
- `modelAdaptations.ts`：`renderCuratedAdaptation` 变成纯渲染器——先写入被 minimal 委派的四条 core clause（来自 `renderDelegatedBehaviorContract`），再声明「authored for this repository and hand-written / not measured tendencies / 冲突时以上层指令为准」，最后追加 curated 正文；新增 `DEEPSEEK_ADAPTATION_SOURCE_ID` 供优化器报告使用。
- `behaviorContract.ts`：新增 `delegatedMinimalContractIds()` 与 `renderDelegatedBehaviorContract()`，作为「minimal 委派清单」的唯一来源。
- `deepseekAdaptationService.ts` 未改：它本来就只负责家族判定（经 `loadCuratedAdaptation` 的 `curatedAdaptation` 门）、in-flight 缓存、reminder 注册与 lastInjection 去重；内容构造已在纯渲染器一侧。

**验收证据**
- `bun test --isolate test/features/deepseekAdaptation/deepseekAdaptation.test.ts test/agent/agentsMdReminder/agentsMdReminder.test.ts test/app/agentProfileCatalog/adaptationRender.test.ts` → 86 pass / 1 skip / 0 fail。
- 新用例断言：reminder 含四个委派 id 的 anchor，且不含两个 core clause 的 anchor（不重复 system 已投递的内容）；含 `hand-written` 与 `not measured`。
- 既有生命周期用例继续通过：非 DeepSeek 不注入、DeepSeek 注入一次、同一上下文再跑一步不重复、compaction 后恰好重注入一次、role 为 `user` 且带 `<system-reminder>`。

## Task 5 — 优化器改为生产渲染 ✅

**交付（`scripts/prompt-optimizer/`）**
- 新增 `src/rendered-prompt.ts`：`renderProfile({ profile, model, fixture, actualGlobalPath? })` 调用 agent-core 的 `renderSystemPromptResult`（不启动 DI、不读真实 home），返回 system/reminder/contractDelivery/valueDelivery/warnings/sourceHash/tokens/fixtureSummary；profile 与模型形状不匹配抛 `profile_model_mismatch`，缺 cwd 抛 `fixture_incomplete`。
- `--actual-global <path>`：只接受 `C:/Users/Administrator/.kimi-code/AGENTS.md`（归一化比较），其他路径 `actual_global_path_rejected`（fail closed、不读取）；正文只进内存，`fixtureSummary` 只记录 `agentsMd: 'actual'` 与字符数。
- `src/redact.ts`：报告侧密钥样式清洗与截断。
- `src/benchmark/runner.ts`：`runRenderedCase` / `runRenderedSuite`，reminder 以 `user-prelude` 的 `<system-reminder>` 消息注入并记录角色/位置；单条失败进 `apiErrors`，不再中断整个 suite。
- `src/benchmark/cases.ts`：`CASE_CONTRACT_IDS` 为全部 41 条用例映射 core id（加载期校验无遗漏），新增 6 条契约域用例；工具类用例带 `availableTools` 并用 `tool-called`/`tool-not-called` 评真实调用。
- `src/cli.ts`：`bench` 默认走 `renderProfile`；`--compare`/`--variant` 明确标注 `raw-template experiment`。

**验收证据**
- `cd scripts/prompt-optimizer && bun test` → 173 pass / 0 fail（18 files；新增 `rendered-prompt`、`rendered-benchmark`、`eval-report` 三个文件）。
- `bun src/cli.ts bench --dry-run --profile full --model kimi-k3-1` → 41 cases，6/6 契约 `system`，system 2495 tokens，verdict `unavailable`。
- `bun src/cli.ts bench --dry-run --profile deepseek-adapted --model deepseek-v4-pro` → 2 `system` + 4 `reminder`，system 154 / reminder 1295 tokens，verdict `unavailable`。
- 错误路径实测：`--profile full --model deepseek-v4-pro` → exit 2（`profile_model_mismatch` 同时点名 profile 与模型）；未知 profile → exit 2（列出合法值）；未授权 `--actual-global` → exit 2（`actual_global_path_rejected`，不读取）。
- 新增 `scripts/prompt-optimizer/src/render-fixture.ts`（Task 7 Step 4 的离线渲染检查）：full 与 deepseek 均 `warnings=0 unresolved=0 contractGaps=0`。

## Task 6 — 报告完整性与真实评测门禁 ✅

**交付**
- `src/report/report.ts`：`buildEvaluationReport` 产出 `schemaVersion / model / profile / sourceHash / fixtureSummary / contractCoverage / cases / totals / apiErrors / dryRun / effectivenessVerdict / effectivenessBlockers`；`ContractCoverageError` 在任一 core id 既非 system 也非 reminder 时拒绝出报告；`reportCompletenessErrors` 校验必备字段与「无正文/无密钥」。
- verdict 规则：dry-run、渲染 warning、缺凭据、provider 失败、模型未产出结果 → `unavailable` + 具体 blocker；`apiErrors` 区分 `provider_failure` 与 `model_failure`。
- `cases[].rawOutput` 不再写入报告（只保留评分、violations 与 token）。

**验收证据**
- `test/eval-report.test.ts` 16 条：schema 字段齐全、密钥样式零命中、dry-run/unavailable、provider 失败分类、contract 缺口抛错。
- 实测报告 JSON：12 个顶层字段，`secretPatternHit=false`，`rawOutput` 不存在，`contractCoverage` 覆盖六个 id。

**偏差**
- `model_failure` 目前只能由调用方显式抛 `ModelFailureError` 触发；仓库自带的 `llm-caller` 抛普通 `Error`，因此真实 provider 路径会被归为 `provider_failure`。报告两类都支持并有测试覆盖，但当前真实路径只产生后者。

## Task 7 — 文档与跨模块校验 ✅

**交付**
- `DEVELOP.md` 新增 `## Prompt Assets and the Prompt Optimizer`：单一所有权表、离线渲染检查、优化器 dry-run / 真实评测命令、`--profile` 与模型匹配规则、`--actual-global` 数据边界、个人全局提示词不提交。
- `docs/en/llm.md` 与 `docs/zh/llm.md`：补充 `valueDelivery` / `contractDelivery` / warnings 语义，以及 reminder 由「委派契约 + 来源声明 + curated 正文」组合而成。
- `scripts/prompt-optimizer/src/render-fixture.ts`：离线渲染检查入口（Task 7 Step 4 的固定命令）。

**验收证据**
- focused agent-core 与 optimizer 两套命令通过（见上）。
- `bun run typecheck`：所有包 exit 0（修复 node-sdk 的 `vi` 残留后）。
- `bun run lint`：0 errors / 14232 warnings（既有）。
- 离线端到端：同一 fixture 渲染 full 与 deepseek，契约覆盖分别为 6/6 system 与 2 system + 4 reminder，token 估算分别 2495 与 154+1295，均无 unresolved/warning。
- `bun run check:boundaries` 的失败为既有问题，详见下一节。

## 外部阻塞与既有失败

- **真实模型评测未进行**：本机没有 provider 凭据（`KIMI_API_KEY` / `config.toml` 均无可用 key），所有评测输出均为 `dryRun: true`、`effectivenessVerdict: "unavailable"`。这不是「通过」，只能算离线结构验证。
- **`bun run check:boundaries` 既有失败**：14 处 `deep import into the engine`，全部位于 `packages/product`（session-rating）与 `packages/kap-server`（sessionRating 测试）。`norust` 上同样存在（`git show norust:packages/product/test/survey-turns.test.ts` 即含 `internal/forkTurnSlice` 深导入），本次改动未触及这些包，也没有修改 baseline。命令与类别：import-boundary violation，非本次引入。
- **规格命令不可用**：规格写的 `bunx vitest run …`、以及 `bun run test` 在旧记录里提到的 vitest，均已被仓库的 Bun 测试迁移取代；`bunx vitest run` 实测报 `Cannot find package 'bun:test'`。所有测试改用 `bun test --isolate`。
- **`bun run test` 的逐包结果（既有失败，非本次引入）**：
  - `@moonshot-ai/agent-core-v2`：454 files，7886 pass / 3 fail / 0 errors / 43 skip；另 `test/persistence/backends/node-fs/appendLogStore.test.ts` 300 s HANG。失败文件：`test/features/btw/btw.test.ts`（read-only veto re-attach）、`test/session/sessionActivity/sessionRunGate.test.ts`、`test/session/agentLifecycle/agentLifecycle.test.ts`。对应的生产文件（`features/btw/btw.ts`、`session/sessionActivity/sessionRunGate.ts`、`session/agentLifecycle/agentLifecycleService.ts`、`persistence/backends/node-fs/appendLogStore.ts`）均由 WIP 占用锁提交改过。
  - `@moonshot-ai/kap-server`：70 files，1374 pass / 2 fail / 0 errors / 9 skip；失败文件 `test/prompts.test.ts`（transient upload、unknown agent 40401）。
  - `@moonshot-ai/kimi-code-sdk`：30 files，297 pass / 7 fail / 0 errors / 3 skip；失败文件 `test/auth-facade.test.ts`、`test/session-plan-compact-usage-resume.test.ts`。
  - `@moonshot-ai/remote-control`：唯一文件 `test/remote-control.test.ts` 300 s HANG（0 通过、0 失败、0 错误）。
  - `kimi-code`（`apps/vscode`）：25 files，369 pass / 36 fail / 0 errors / 8 skip；失败文件 `test/app-init.test.ts`、`test/settings-store.test.ts`，webview 用例报 `Cannot call beforeAll() inside a test`（`@testing-library/react` 与 `bun:test` 的既有不兼容）。
  - `@moonshot-ai/kimi-code`（`apps/kimi-code`）：290 files，4675 pass / 42 fail / 0 errors / 22 skip；失败文件 `test/tui/kimi-tui-message-flow.test.ts`（37 条，WIP TUI 移植）、`test/cli/v2-run-print.test.ts`（WIP print 占用处理）、`test/tui/components/chrome/footer-status-line.test.ts`（并行争用，单独跑通过；runner 已标 FLAKY(contention)）。
  归因依据：本次 diff 只触及 `agentProfileCatalog` 及其三份测试、`node-sdk` 的一个测试文件（`vi` 修复）、`scripts/prompt-optimizer`、文档与两个检查脚本；上述失败文件无一在这些路径内。
- **node-sdk 的 `vi` 残留（本 spec 范围外的阻塞修复）**：WIP 提交 `f4bb860b0f` 在 `packages/node-sdk/test/sdk-rpc-client-v2.test.ts` 里留下了 9 处 vitest 的 `vi.spyOn`/`vi.fn`，`bun run typecheck` 首轮在此失败（`TS2304: Cannot find name 'vi'`，`@moonshot-ai/kimi-code-sdk typecheck: Exited with code 2`）。该仓库的测试基础设施是 `bun:test`，已改为文件里已导入的 `spyOn` 与 `mock`；修复后该文件 76 pass / 3 skip / 0 fail，仓库 typecheck 转绿。

## 证据分级

**已实现的行为（代码存在且可达）**
- 六个 core contract id 及 full/minimal 投影、三种投递通道、未解析变量告警。
- `system.md` / `system.minimal.md` 的契约化表达与去重；project/plugin 仍为 reference data。
- DeepSeek reminder = 四条委派契约 + 来源声明 + curated 正文；服务只做生命周期。
- 优化器以生产渲染输入跑 benchmark，`--profile`/`--actual-global` 严格校验，报告 schema 与门禁。

**红阶段的留痕完整性**
- Task 1：先写测试，`bun test --isolate test/app/agentProfileCatalog/profile-shared.test.ts` 报 `Cannot find module '#/app/agentProfileCatalog/behaviorContract'`（模块创建前的预期红），随后实现转绿。
- Task 3：先加 parity/去重用例，去重用例报 `Expected length: 2, Received length: 3`（同句在契约与模板各出现一次），收敛措辞后转绿。
- Task 4：先加内容用例，报 `error: tools_and_repository_context` 与 provenance 断言失败，扩展纯渲染器后转绿。
- Task 5/6：红阶段由委派的实现者执行，其失败输出未随交接保留；本次复核的是实现后的 173 条绿、两套 dry-run 与三条错误路径。这两项的红阶段记为「未独立留痕」，不等同于已验证。

**已验证的行为（命令 + 结果）**
- agent-core 指定三套件 208 pass / 1 skip / 0 fail；optimizer 173 pass / 0 fail；`check:no-comments` OK；`check:prompt-ownership` OK；两套 dry-run 与三条错误路径；报告字段与无密钥/无正文。
- 全局文件的私有校验（计数、标题、去重、密钥样式）与备份。

**真实模型评测**
- 未进行。无凭据，因而没有任何「模型行为提升」的结论。

**仅 dry-run 证据**
- benchmark 的通过率、rule compliance、tool accuracy 等数字全部来自 dry-run caller；报告已标 `dryRun: true` 与 `unavailable`，不得当作效果结论。

**外部阻塞**
- provider 凭据缺失（阻塞真实评测）。
- `check:boundaries` 的既有 14 处深导入（阻塞该命令转绿，但不在本次改动范围）。

## 偏差与原因（汇总）

| # | 偏差 | 原因 |
| --- | --- | --- |
| 1 | 用 `bun test --isolate` 代替规格的 `bunx vitest run` | 仓库测试导入 `bun:test`，vitest 无法执行（实测报错） |
| 2 | Task 1 阶段就把 `${behavior_contract}` 注入模板，Task 3 再做措辞收敛 | 契约必须有真实投递点才能测试「delivered」，否则 Task 1 只能测元数据 |
| 3 | 修改 app 层 `deepseekAdaptation.test.ts` 的 minimal 断言 | minimal 有意不再复制 v4.1 三段；断言改为 handoff + reminder 承载 |
| 4 | `--profile minimal` 对当前目录被拒绝（exit 3，不写报告） | 裸 minimal 让四条契约无投递通道；门禁拒绝比出「完整」假报告正确 |
| 5 | `full` 的校验实现为「不是 minimal」 | `promptShapeForModel` 只返回 `'minimal' \| undefined`，没有字面 `'full'` |
| 6 | 优化器默认 fixture 使用合成 AGENTS 文本 | 仓库 `AGENTS.md` 解释注入时字面包含 `${agents_md}`，会触发未解析变量扫描并使每次运行不可用，也会让 sourceHash 随文档编辑漂移 |
| 7 | `contractIds` 放在 `CASE_CONTRACT_IDS` 旁表而非逐条内联 | 保持既有用例对象逐字节不变，同时用加载期校验保证无遗漏 |
| 8 | `test/pruner.test.ts` 的 `UNCOVERED` 标题从 `Delivering work` 改为 `Skills` | 新契约用例合法覆盖了 `Delivering work`，覆盖判定随之变化；断言长度仍为 0 |
| 9 | `rule-no-git-commit` 增加 `availableTools` | 原先 `tool-not-called: Bash` 在没有工具时是空断言；补齐后是真实工具调用断言 |
| 10 | 全局指令只做标题级重排、正文逐行保留 | 「正文不写日志」使逐句语义改写不可行；语义优化留待用户本地进行 |
| 11 | 修复 `packages/node-sdk/test/sdk-rpc-client-v2.test.ts` 的 9 处 `vi` | 它是 WIP 提交 `f4bb860b0f` 的残留，阻断 `bun run typecheck`；改为 `bun:test` 的 `spyOn`/`mock` 后该文件与 typecheck 均转绿 |

## Final completion gate

- [x] Task 1–7 均有实现与证据，无占位或补丁式改动。
- [x] 全局提示词清单（前后标题、行数、字节数、重复与密钥检查）已在仓库外核对，目标 9951 B < 32 KiB。
- [x] 仓库 diff 不含全局正文、密钥样式或临时报告（`reports/*.json` 已删除且被 gitignore）。
- [x] focused tests、optimizer tests、typecheck、lint、全量测试结果已记录（含既有失败的类别与命令）。
- [x] 报告区分已实现行为、已验证行为、真实模型评测、仅 dry-run 证据与外部阻塞。
