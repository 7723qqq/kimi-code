# 提示词治理与模型适配重构 — 实施任务

> 每项任务都必须完成其验收条件后再进入下一项；涉及现有提示词的修改必须保留行为契约映射和回归证据。

## 文件与模块总览

- 修改：`C:/Users/Administrator/.kimi-code/AGENTS.md`，仅保存本机全局指令重构；不提交仓库。
- 修改：`AGENTS.md`、`DEVELOP.md`，项目指令入口与规则所有权。
- 修改：`packages/agent-core-v2/src/app/agentProfileCatalog/system.md`、`system.minimal.md`、`model-adaptations/curated/deepseek.md`，运行时提示词资产。
- 新增或修改：`packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts`（最终名称可在实现中按现有命名调整），共享行为契约及渲染输出。
- 修改：`packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts`、`packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations.ts`、`packages/agent-core-v2/src/agent/profile/profileService.ts`、`packages/agent-core-v2/src/features/deepseekAdaptation/deepseekAdaptationService.ts`，统一投递与状态记录。
- 修改：`scripts/prompt-optimizer/src/cli-args.ts`、`config.ts`、`types.ts`、`prompt-parser.ts`、`benchmark/runner.ts`、`benchmark/cases.ts`、`report/report.ts` 及必要的新 adapter/fixture 模块。
- 测试：现有 `packages/agent-core-v2/test/app/agentProfileCatalog/profile-shared.test.ts`、`adaptationRender.test.ts`、`packages/agent-core-v2/test/features/deepseekAdaptation/deepseekAdaptation.test.ts`、`packages/agent-core-v2/test/agent/agentsMdReminder/agentsMdReminder.test.ts`；新增测试仅在现有测试体系中补充。
- 测试：`scripts/prompt-optimizer/test/*.test.ts` 中的 CLI、runner、报告和离线渲染测试。

## Review Focus

- **Minimal profile 中空的必需上下文**：生产渲染和报告必须分别标记 `delivered`、`reminder` 或 `intentionally_omitted`，测试放在 Task 3 与 Task 6。
- **DeepSeek reminder 重复/丢失**：同一上下文只注入一次，compaction 后恢复一次，测试放在 Task 4。
- **全局提示词中的个人/安全规则被重排时丢失**：修改前后契约 id 清单相同，测试/脚本放在 Task 2。
- **不可信 AGENTS/plugin/skill 内容夺取权限**：full 和 minimal+reminder 都必须拒绝越权指令，benchmark case 放在 Task 5。
- **dry-run 被误读为效果结论**：报告必须带 `dryRun` 与 `effectivenessVerdict: unavailable`，测试放在 Task 6。

## Task 1: 建立行为契约与投递模型

**Files:**
- Create: `packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts`
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts`
- Test: `packages/agent-core-v2/test/app/agentProfileCatalog/profile-shared.test.ts`

**Interfaces:**
- Produces a stable list of core contract ids and render functions for full and minimal profiles.
- Produces delivery metadata distinguishing `system`, `reminder`, and `intentionally_omitted` values.
- Keeps `SystemPromptRenderResult` backward-compatible; new delivery fields are optional until all callers migrate.

- [ ] **Step 1: Write failing tests**
  - Add tests that render a full fixture and assert every core contract id is delivered in the system text.
  - Add tests that render a DeepSeek fixture and assert core ids are delivered either in minimal system text or adaptation reminder metadata; no non-empty context is silently dropped.
  - Add a test that an unresolved `${name}` placeholder is reported as an error/warning result, not accepted as rendered output.

- [ ] **Step 2: Run focused tests and verify failure**
  - Run `bunx vitest run packages/agent-core-v2/test/app/agentProfileCatalog/profile-shared.test.ts`.
  - Expected: new contract/delivery assertions fail before implementation.

- [ ] **Step 3: Implement the contract module and profile projection**
  - Define typed contract ids for authority, act/verify, tools/context, safety/scope, failure/partial progress, and communication.
  - Define a projection that returns rendered text plus delivery records; full profile embeds the full clauses, minimal profile embeds only the short core and declares the remainder for family delivery.
  - Keep user-provided project/plugin/model text framed as reference data and preserve existing variable names and `${base_prompt}` behavior.

- [ ] **Step 4: Run focused tests and typecheck**
  - Run the focused vitest command and `bunx tsc -p packages/agent-core-v2/tsconfig.json --noEmit`.
  - Expected: all new and existing profile tests pass; no unresolved placeholder is present in a successful render.

## Task 2: Reorganize project and global instruction documents

**Files:**
- Modify: `AGENTS.md`
- Modify: `DEVELOP.md`
- Modify: `C:/Users/Administrator/.kimi-code/AGENTS.md`
- Test/verify: a local script or command output recorded privately; no global file content copied into repository. The online benchmark input is allowed only through an explicit opt-in flag and the one authorized global path.

**Interfaces:**
- Produces a root project entry that identifies `DEVELOP.md` as the project source of truth and states what is auto-injected versus on-demand.
- Produces a global instruction file with the same contract vocabulary but retains personal Windows/shell/tooling preferences.

- [ ] **Step 1: Create a private pre-edit inventory**
  - Record a redacted list of current section headings, rule identifiers/subjects, and file byte count for the global file outside the repository report path.
  - Confirm the target is exactly `C:/Users/Administrator/.kimi-code/AGENTS.md` and create a recoverable backup before editing.

- [ ] **Step 2: Write document-level contract tests/checks**
  - Add or run a repository-local checker that validates root `AGENTS.md` links to `DEVELOP.md`, no instruction claims `DEVELOP.md` is automatically injected, and required project contract headings exist.
  - Validate the global file privately: required headings exist, no duplicate contradictory rule survives, and sensitive values are not emitted.

- [ ] **Step 3: Rewrite with single ownership and explicit precedence**
  - Keep project-specific architecture/build/test facts in `DEVELOP.md`; keep the root `AGENTS.md` short and navigational.
  - Reorganize global rules into authority, execution, safety, verification, communication, Windows shell, and tool-use sections; remove duplicated process prose while preserving the user’s explicit constraints.
  - Do not copy the global file into git or any report.

- [ ] **Step 4: Verify both instruction surfaces**
  - Run the document checks and inspect `git diff -- AGENTS.md DEVELOP.md` plus the private global diff.
  - Expected: project files contain no personal paths/secrets; global file remains readable under its 32 KiB runtime limit; every inventory item is retained, relocated, or intentionally removed with a reason; no other home file was read or changed.

## Task 3: Rebuild full and minimal prompt assets

**Files:**
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/system.md`
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/system.minimal.md`
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/profile-shared.ts`
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations.ts`
- Test: `packages/agent-core-v2/test/app/agentProfileCatalog/profile-shared.test.ts`
- Test: `packages/agent-core-v2/test/app/agentProfileCatalog/adaptationRender.test.ts`

**Interfaces:**
- Full prompt renders all core contract ids and all existing applicable runtime variables.
- Minimal prompt renders persona, cwd, authority framing, completion/verification rule, and a stable reminder handoff marker without duplicating the complete full prompt.
- `SystemPromptRenderResult.droppedVars` remains meaningful and dedicated delivery metadata explains fields delegated to a reminder.

- [ ] **Step 1: Add regression tests for full/minimal parity**
  - Assert full Kimi fixture contains all core contract markers and project instructions are framed as reference data.
  - Assert DeepSeek fixture contains minimal core markers, omits the complete full sections, and declares delegated contracts rather than silently dropping them.
  - Assert non-DeepSeek models remain byte-for-byte equivalent to the new full baseline for the same context.

- [ ] **Step 2: Run tests to establish failure**
  - Run `bunx vitest run packages/agent-core-v2/test/app/agentProfileCatalog/profile-shared.test.ts packages/agent-core-v2/test/app/agentProfileCatalog/adaptationRender.test.ts`.
  - Expected: parity/delivery tests fail against current minimal template.

- [ ] **Step 3: Update templates and renderer**
  - Rewrite prose around the shared contract without duplicating personal global instructions.
  - Use the shared contract output to mark omitted sections as owned by DeepSeek adaptation delivery.
  - Preserve custom `SYSTEM.md` variable support and avoid changing custom profile precedence.

- [ ] **Step 4: Run focused tests and inspect rendered fixtures**
  - Run the focused tests and a small fixture render command that checks no `${...}` remains.
  - Expected: full and minimal render tests pass and delivery metadata has no unclassified non-empty variables.

## Task 4: Refactor DeepSeek adaptation delivery

**Files:**
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/curated/deepseek.md`
- Modify: `packages/agent-core-v2/src/features/deepseekAdaptation/deepseekAdaptationService.ts`
- Modify: `packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations.ts`
- Test: `packages/agent-core-v2/test/features/deepseekAdaptation/deepseekAdaptation.test.ts`

**Interfaces:**
- Produces one adaptation reminder per live context for DeepSeek family names; no reminder for other families.
- Adaptation content is operational, references stable contract ids, states provenance, and does not claim unsupported measured tendencies.
- Existing cache, restore, compaction, context origin and role behavior remain intact.

- [ ] **Step 1: Add failing lifecycle and content tests**
  - Assert the reminder includes all contracts delegated by minimal prompt, source/provenance framing, and the system-reminder wrapper.
  - Assert Kimi/non-DeepSeek receives no adaptation; DeepSeek receives one; repeated step does not duplicate; compaction causes exactly one reinjection.

- [ ] **Step 2: Run focused adaptation tests and verify failure**
  - Run `bunx vitest run packages/agent-core-v2/test/features/deepseekAdaptation/deepseekAdaptation.test.ts`.
  - Expected: new content/contract assertions fail before the adaptation rewrite.

- [ ] **Step 3: Separate content construction from delivery lifecycle**
  - Add a pure adaptation renderer that consumes the shared contract and curated DeepSeek body.
  - Keep `DeepseekAdaptationService` responsible only for model-family gating, cache, reminder registration and lifecycle.
  - Ensure the service reports source id and contract ids to the delivery metadata used by the optimizer.

- [ ] **Step 4: Run adaptation, reminder and profile tests**
  - Run `bunx vitest run packages/agent-core-v2/test/features/deepseekAdaptation/deepseekAdaptation.test.ts packages/agent-core-v2/test/agent/agentsMdReminder/agentsMdReminder.test.ts packages/agent-core-v2/test/app/agentProfileCatalog/adaptationRender.test.ts`.
  - Expected: all pass, including existing AGENTS reminder lifecycle behavior.

## Task 5: Make the optimizer use production-rendered profiles

**Files:**
- Modify: `scripts/prompt-optimizer/src/cli-args.ts`
- Modify: `scripts/prompt-optimizer/src/config.ts`
- Modify: `scripts/prompt-optimizer/src/types.ts`
- Modify: `scripts/prompt-optimizer/src/prompt-parser.ts`
- Create/modify: `scripts/prompt-optimizer/src/rendered-prompt.ts` or equivalent
- Modify: `scripts/prompt-optimizer/src/benchmark/runner.ts`
- Modify: `scripts/prompt-optimizer/src/benchmark/cases.ts`
- Test: `scripts/prompt-optimizer/test/cli-args.test.ts`, `prompt-parser`/runner tests, and a new rendered-profile test if needed

**Interfaces:**
- A renderer accepts `modelName`, profile preset, and explicit fixture context and returns system text, reminder parts, delivery metadata, source hash and warnings.
- Runner accepts a rendered profile object and sends system/reminder content in an explicit, reportable position.
- CLI supports explicit profile selection and rejects incompatible model/profile combinations instead of silently using a template.

- [ ] **Step 1: Add failing offline renderer and CLI tests**
  - Test full fixture rendering with no placeholders and expected contract ids.
  - Test DeepSeek rendering includes a separate adaptation part and records its source/contract ids.
  - Test missing fixture fields and model/profile mismatch produce named errors/warnings.
  - Test new CLI flags/presets parse and unknown values fail.
  - Test the actual-global opt-in flag is required for the authorized home path, rejects every other path, and reports the selected provider without persisting prompt content.

- [ ] **Step 2: Run optimizer tests to verify failure**
  - Run `cd scripts/prompt-optimizer && bun test`.
  - Expected: new tests fail against the template-only config/runner.

- [ ] **Step 3: Implement production-rendered adapter and runner integration**
  - Import or expose the agent-core pure rendering boundary without starting the DI runtime or reading real home files.
  - Replace default `loadPrompt(system.md)` benchmark input with the selected rendered profile; retain section pruning only for an explicitly declared raw-template experiment.
  - Include prompt source hash, profile, fixture summary, system/reminder token totals and delivery warnings in each result.
  - For the authorized actual-global opt-in, send only the in-memory prompt to the configured provider, redact path/content from report metadata, and fail closed when the requested path differs from `C:/Users/Administrator/.kimi-code/AGENTS.md`.

- [ ] **Step 4: Add behavior cases mapped to contract ids**
  - Extend cases for tool selection, dangerous action confirmation, untrusted instruction isolation, verification before completion, partial failure continuation and language/format behavior.
  - Ensure cases requiring tools provide tool definitions and evaluate actual tool calls rather than only output strings.

- [ ] **Step 5: Run optimizer unit tests and dry-run**
  - Run `cd scripts/prompt-optimizer && bun test` and `bun src/cli.ts bench --dry-run --profile full` plus the DeepSeek preset.
  - Expected: tests pass; output explicitly says dry-run is not an effectiveness verdict; reports include profile, delivery metadata and `dryRun: true`.

## Task 6: Add report completeness and real-evaluation safeguards

**Files:**
- Modify: `scripts/prompt-optimizer/src/report/report.ts`
- Modify: `scripts/prompt-optimizer/src/benchmark/runner.ts`
- Modify: `scripts/prompt-optimizer/src/cli.ts`
- Modify: `scripts/prompt-optimizer/src/types.ts`
- Test: `scripts/prompt-optimizer/test/eval-outcome.test.ts`, report/runner tests, credential tests

**Interfaces:**
- Report schema includes model, profile, source hash, fixture summary, contract coverage, case results, token usage, API errors, `dryRun`, and `effectivenessVerdict`.
- No API key or prompt private content is written to report metadata.
- Missing credentials produce either explicit dry-run mode or an actionable error; never a real-effectiveness report.

- [ ] **Step 1: Add failing report assertions**
  - Assert all required fields and no secret-like values.
  - Assert dry-run and provider failure statuses are distinguishable from model failures.
  - Assert contract completeness gate fails when a profile has an unclassified core contract.

- [ ] **Step 2: Implement report and failure semantics**
  - Aggregate by profile and contract id; preserve raw output only under the existing report policy and redact credential-like material.
  - Emit `effectivenessVerdict: unavailable` for dry-run, renderer warning, missing key or provider failure.

- [ ] **Step 3: Run tests**
  - Run `cd scripts/prompt-optimizer && bun test`.
  - Expected: all optimizer tests pass and generated reports satisfy the schema assertions.

## Task 7: Integrate documentation and run cross-module checks

**Files:**
- Modify: `DEVELOP.md` prompt optimizer/project instruction sections
- Modify: `AGENTS.md` if Task 2 needs final entry wording
- Modify: relevant `docs/` prompt-optimizer/customization documentation only if an existing page owns this workflow
- Test: repository script checks and agent-core tests

- [ ] **Step 1: Document the new prompt ownership and commands**
  - State which files own shared contracts, full/minimal expression, DeepSeek delivery and optimizer fixtures.
  - Document commands for offline render checks, optimizer dry-run and real evaluation with explicit model/profile.
  - State that personal global prompt changes are local and never committed.

- [ ] **Step 2: Run focused project checks**
  - Run `bunx vitest run packages/agent-core-v2/test/app/agentProfileCatalog packages/agent-core-v2/test/features/deepseekAdaptation packages/agent-core-v2/test/agent/agentsMdReminder`.
  - Run `cd scripts/prompt-optimizer && bun test`.
  - Run `bun run check:boundaries` and `bun run typecheck`.

- [ ] **Step 3: Run the standard verification set**
  - Run `bun run lint` and `bun run test` if the focused commands pass.
  - Expected: changed-module tests, typecheck, boundaries and lint pass; any pre-existing/environment failure is recorded with exact command and failure category.

- [ ] **Step 4: Verify the user scenario end to end**
  - Render a full Kimi fixture and a DeepSeek fixture, inspect the actual system/reminder payloads, run both through the same benchmark cases, and compare contract coverage plus token totals.
  - Expected: no silent variable loss, DeepSeek reminder lifecycle is correct, both profiles have complete core contract delivery, and no effectiveness claim is made without a real model call.

## Final completion gate

- [ ] All tasks above are complete; no task is left as a placeholder or a best-effort patch.
- [ ] Global prompt inventory before/after is reconciled privately and the target remains within runtime limits.
- [ ] Repository diff contains no global prompt body, secrets, scratch reports or untracked test artifacts.
- [ ] Focused tests, optimizer tests, typecheck, boundaries and standard lint/test results are recorded.
- [ ] Final report distinguishes implemented behavior, verified behavior, real-model evaluation, dry-run-only evidence and any external blocker.
