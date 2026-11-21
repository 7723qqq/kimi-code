# 2.6.3 Request-Correctness Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and verify the five approved 2.6.3 request-correctness behaviors in the existing Bun fork architecture.

**Architecture:** Port behavior, not upstream structure: keep tool filtering in the existing tool-select projection, response settlement in the shared pure LLM rule with both consumers using it, and usage normalization in the OpenAI base parser. Reuse current test harnesses and local socket fixture to prove actual provider-facing requests and retry boundaries. Record release-only evidence without changing package versions or release changelogs.

**Tech Stack:** TypeScript, Bun 1.4.4, `bun:test`, local `Bun.serve` mock upstream.

**Spec:** `specs/quasar-jade-hourman/{requirements,design,tasks}.md`

## Global Constraints

- Production changes stay inside `packages/agent-core-v2` plus one user-facing changeset.
- Preserve public APIs, server wire shapes, dependency set, retry/timeouts, model/tool policy filters, history, and persisted tool-selection state.
- Do not change package versions or release changelogs, merge upstream main, publish, commit, or push in this tranche.
- Implement the five named release-tag behaviors only; report remaining 2.6.3 areas as unfinished.
- Follow `DEVELOP.md`, `CONVENTIONS.md`, `src/human/AGENTS.md`, `src/human/llm/AGENTS.md`, and `docs/en/llm.md` at their owning paths.

## Review Focus

- A non-dynamic model must receive each permitted deferred builtin, user and unloaded MCP tool once, but never `select_tools` or disabled/denied tools; assert at the provider request boundary in Task 1.
- Switching a session from dynamic to static disclosure must not mutate pinned schemas or persisted initial tool state; assert in Task 1.
- Retryable failure then overflow must retain one active turn/step association and agree on live versus cold replay; assert in Task 5.
- A `repeat` response with text or a complete tool call must fail before success/tool execution, while filtered empty output remains non-retryable; assert in Task 2.
- EOF without finish after text, whitespace, reasoning, or partial tool arguments must not produce success; cancellation and fresh retry state must remain correct; assert in Task 3.
- Top-level usage (including `{}`) wins over first-choice usage; absent/null top-level usage falls back once; missing usage emits none; assert in Task 4.

---

### Task 1: Deferred tool fallback for models without dynamic loading

**Files:**
- Modify if the regression proves a gap: `packages/agent-core-v2/src/agent/toolSelect/toolSelectService.ts`
- Test: `packages/agent-core-v2/test/agent/toolSelect/toolSelectService.test.ts`
- Test: `packages/agent-core-v2/test/agent/llmRequester/llmRequesterService.test.ts`
- Test: `packages/agent-core-v2/test/llm-adapter/model/modelRequester.test.ts` only if required to assert final provider-visible wire tools.

**Interfaces:**
- Consumes: `IAgentToolSelectService.defaultTools(disclosure?)`, `AgentLLMRequesterService` request resolution, and `ModelRequesterImpl`'s existing wire-tools filtering.
- Produces: No new public interface. Default tool projection yields exactly one entry per eligible static-model tool, with no deferred marker reaching provider serialization.

- [ ] **Step 1: Add a failing provider-request regression.** Exercise an active builtin, deferred user tool, deferred MCP tool whose schema is not loaded, an inactive/denied tool, and `select_tools` with `dynamically_loaded_tools: false`. Inspect actual serialized provider-request tools, not just registry or snapshot state. Assert eligible tools appear once, have no `deferred: true`, and prohibited tools are absent.
- [ ] **Step 2: Run the regression and record whether it fails.**

Run from `packages/agent-core-v2`: `bun test --isolate test/agent/toolSelect/toolSelectService.test.ts test/agent/llmRequester/llmRequesterService.test.ts test/llm-adapter/model/modelRequester.test.ts`

Expected: a failure names the missing or duplicated provider-visible tool; if the complete request assertions already pass, retain the test as evidence and make no production change.
- [ ] **Step 3: Add the model-transition regression.** Start with dynamic disclosure, resolve a later non-dynamic model request, and assert the provider payload switches to static tool definitions while historical schema messages, persisted initial tool snapshot and caller-provided explicit tool selection stay unchanged.
- [ ] **Step 4: Implement only the uncovered projection behavior.** Keep profile/permission filtering, `select_tools` suppression, explicit overrides and the global `wireTools` safety filter intact; do not mutate canonical state to remove the presentation-only marker.
- [ ] **Step 5: Re-run the focused regression command.** Expected: all assertions pass, including existing dynamic disclosure and historical schema-pinning cases.

### Task 2: Reject repeated responses before either settlement path accepts them

**Files:**
- Modify: `packages/agent-core-v2/src/human/llm/empty-response.ts`
- Modify: `packages/agent-core-v2/src/human/agent/turn.ts`
- Modify: `packages/agent-core-v2/src/llm-adapter/model/model-requester-impl.ts`
- Test: `packages/agent-core-v2/src/human/test/llm/empty-response.test.ts`
- Test: `packages/agent-core-v2/src/human/test/agent/turn.test.ts`
- Test: `packages/agent-core-v2/test/llm-adapter/model/modelRequester.test.ts`

**Interfaces:**
- Consumes: `AssistantMessage`, `LlmModel`, `FinishInfo`, `emptyResponseError()`, and the existing error conversion.
- Produces: A shared pure empty-response classification rule that treats raw finish reason `repeat` as retryable `kind: 'empty_response'` before content/tool-call success checks; existing error type is preserved.

- [ ] **Step 1: Add kernel and adapter tests.** Supply visible text with `rawFinishReason: 'repeat'` and a complete tool call with that raw reason. Assert the error is retryable `empty_response`, preserves raw finish details, and includes a repeated-output diagnostic. Assert normal completed text/tool calls still succeed and filtered empty output remains non-retryable.
- [ ] **Step 2: Run the tests to establish the regression.**

Run from `packages/agent-core-v2`: `bun test --isolate src/human/test/llm/empty-response.test.ts src/human/test/agent/turn.test.ts test/llm-adapter/model/modelRequester.test.ts`

Expected: the repeated response is incorrectly accepted or a rejected tool call is executed before the fix.
- [ ] **Step 3: Add a turn-level tool non-execution assertion.** Verify that a tool call accompanied by `repeat` never reaches the tool executor.
- [ ] **Step 4: Implement the shared classification and place it before success/tool dispatch in both consumers.** Keep `emptyResponseError()` as the sole policy owner and avoid duplicate consumer-specific checks.
- [ ] **Step 5: Re-run the focused test command.** Expected: repeat cases fail safely; normal success and filtered-empty behavior are unchanged.

### Task 3: Reject streaming EOF without a finish event and isolate retries

**Files:**
- Modify: `packages/agent-core-v2/src/human/llm/empty-response.ts`
- Modify: `packages/agent-core-v2/src/human/agent/turn.ts`
- Modify: `packages/agent-core-v2/src/llm-adapter/model/model-requester-impl.ts`
- Test: `packages/agent-core-v2/src/human/test/agent/turn.test.ts`
- Test: `packages/agent-core-v2/test/llm-adapter/model/modelRequester.test.ts`
- Test: `packages/agent-core-v2/src/human/test/llm/fast-upstream.test.ts`
- Modify only if needed for a deterministic fixture: `packages/agent-core-v2/test/helpers/mockUpstream.ts`

**Interfaces:**
- Consumes: Task 2's shared response-settlement rule and `NO_FINISH` distinction.
- Produces: A shared pure terminal-outcome validator, accepting `(message: AssistantMessage, model: LlmModel, finish: FinishInfo | undefined)` and returning `LlmErrorMessage<'empty_response' | 'provider'> | null`; missing finish after non-empty output returns a retryable provider failure.

- [ ] **Step 1: Add failing settlement tests for missing finish.** Cover nonempty text, whitespace-only text, reasoning-only output, and unfinished tool-call arguments at EOF. Assert an empty/reasoning-only response retains its current classification, nonempty incomplete output is a retryable provider failure, and incomplete tool calls are never executed.
- [ ] **Step 2: Run focused tests before implementation.**

Run from `packages/agent-core-v2`: `bun test --isolate src/human/test/agent/turn.test.ts test/llm-adapter/model/modelRequester.test.ts src/human/test/llm/fast-upstream.test.ts`

Expected: at least the nonempty or unfinished-tool EOF case currently succeeds when it must fail.
- [ ] **Step 3: Pin the transport boundary on the local socket.** Have the existing mock send content and close without a finish frame; assert one provider failure, no finish event, and no fabricated success. Keep the existing early/truncated stream scenario semantics.
- [ ] **Step 4: Add a retry-isolation test.** Make the first attempt emit partial text/tool arguments then end without finish, and the next emit a valid completed response. Assert the final message contains only the second attempt and the completed request succeeds. Verify ordinary finish and abort/cancellation paths.
- [ ] **Step 5: Implement shared completion validation and attempt-scoped finish reset.** Call it before kernel `llm.done` success/tool execution and before adapter success emission. Preserve cancellation/error conversion, existing retry/timeout defaults, and the current non-streaming protocol contract; do not add a configuration switch.
- [ ] **Step 6: Re-run the focused test command.** Expected: both consumers reject missing-finish responses and the real socket + retry-isolation assertions pass.

### Task 4: Fall back to first-choice OpenAI usage in the base parser

**Files:**
- Modify: `packages/agent-core-v2/src/human/llm/requester/bases/openai/contract.ts`
- Modify: `packages/agent-core-v2/src/human/llm/requester/bases/openai/format.ts`
- Modify: `packages/agent-core-v2/src/human/llm-kimi/trait.ts`
- Test: `packages/agent-core-v2/src/human/test/llm/usage.test.ts`
- Test: `packages/agent-core-v2/src/human/test/llm/trait.test.ts`
- Test: `packages/agent-core-v2/src/human/test/llm/fast-upstream.test.ts`

**Interfaces:**
- Consumes: `OpenAIRawUsage`, `OpenAIRawChunk`, `parseOpenAIUsage()`, and existing `resolveUsage` extension point.
- Produces: `OpenAIRawChunk.choices[].usage?: OpenAIRawUsage | null`; base parser chooses `chunk.usage ?? chunk.choices?.[0]?.usage` and parses/emits once. Kimi no longer overrides this shared wire rule.

- [ ] **Step 1: Add failing direct-parser cases.** For choice usage `{prompt_tokens: 5, completion_tokens: 1}`, test missing and null top-level usage and expect `{inputOther: 5, output: 1, inputCacheRead: 0, inputCacheCreation: 0}` exactly once. Add contradictory top-level `{prompt_tokens: 120, completion_tokens: 30}` and verify it wins; verify top-level `{}` wins; verify absent usage at both levels emits none.
- [ ] **Step 2: Run the parser and trait tests to establish the regression.**

Run from `packages/agent-core-v2`: `bun test --isolate src/human/test/llm/usage.test.ts src/human/test/llm/trait.test.ts`

Expected: choice-only usage is currently absent in the base OpenAI requester while Kimi-specific fallback tests remain intact.
- [ ] **Step 3: Implement the optional choice field and base fallback.** Keep the top-level empty object authoritative, preserve cache-split semantics and call `parseOpenAIUsage` only once per chunk. Remove only Kimi's redundant fallback.
- [ ] **Step 4: Extend the existing real-socket requester test.** Verify the OpenAI-compatible wire response with usage only at the first choice produces the expected usage event, without top-level double counting.
- [ ] **Step 5: Run all three owning test files.**

Run from `packages/agent-core-v2`: `bun test --isolate src/human/test/llm/usage.test.ts src/human/test/llm/trait.test.ts src/human/test/llm/fast-upstream.test.ts`

Expected: base OpenAI and Kimi usage precedence tests pass, and existing cache-split cases remain unchanged.

### Task 5: Prove retry followed by overflow compaction and replay

**Files:**
- Modify only if regression proves a gap: `packages/agent-core-v2/src/agent/loop/loopService.ts`
- Modify only if regression proves a gap: `packages/agent-core-v2/src/agent/loop/machine/engine.ts`
- Test: `packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts`
- Test: `packages/agent-core-v2/test/agent/loop/loop.test.ts`

**Interfaces:**
- Consumes: Existing `AgentLoopService.gate()`, `MachineEngine` `llm.sent` projection, retry/error recovery and cold-resume helpers.
- Produces: No new API. Each retry/recovery/final response remains associated with the active turn and attempt, and live/cold replay reconstructs equivalent completed history.

- [ ] **Step 1: Extend the current provider-overflow fixture.** Make the provider sequence exactly: retryable 429, context overflow, successful compaction-summary generation, successful final answer. Emit the same `llm.sent` lifecycle events as production on each invocation.
- [ ] **Step 2: Run the targeted full-compaction and loop tests before changing production code.**

Run from `packages/agent-core-v2`: `bun test --isolate test/agent/fullCompaction/fullCompaction.test.ts test/agent/loop/loop.test.ts`

Expected: either a targeted assertion reveals missing request/step projection, lost pending prompt, incorrect completion, or non-equivalent replay; otherwise record the existing behavior as equivalent and do not patch production.
- [ ] **Step 3: Assert the recovery contract.** Expect exactly four provider invocations; compaction starts and completes; the pending user prompt survives; the recovered answer is persisted; the original turn ends completed; failed attempts and the final answer map to the active turn without duplicate `step.begin`; cold replay matches live history.
- [ ] **Step 4: If and only if an assertion demonstrates missing state, repair it at the existing gate/projection boundary.** Preserve configured max-step cap, ordinary retry numbering, cancellation, and attempt UUID pairing.
- [ ] **Step 5: Re-run both focused test files.** Expected: the deterministic four-call sequence, step state and replay assertions pass together with current retry, budget and cancellation tests.

### Task 6: Verify and record the tranche deliverable

**Files:**
- Modify: `.upstream/PLAYBOOK.md`
- Create: one `.changeset/<generated-id>.md` for `@moonshot-ai/kimi-code`, using the existing changeset workflow
- No package version or `CHANGELOG.md` changes.

- [ ] **Step 1: Run the five focused regression groups on the final code.** Expected: every owning test group from Tasks 1–5 passes.
- [ ] **Step 2: Run the `agent-core-v2` package checks sequentially.** From `packages/agent-core-v2`, run `bun run test`, then `bun run typecheck`, then `bun run build`; each must exit 0, or its precise failure must be investigated and resolved before completion.
- [ ] **Step 3: Run repository gates.** From the repository root, run `bun run check:boundaries`, `bun run check:no-comments`, lint only changed TypeScript files using the repository's documented lint runner, and `git diff --check`. Expected: all applicable checks exit 0.
- [ ] **Step 4: Record upstream release-only evidence.** Inspect `.upstream/PLAYBOOK.md` and supported ledger tooling; record each of the five exact commit IDs with the passing probe and `ported` or evidence-backed `equivalent` result. Do not invent a mainline ledger row for release-only commits.
- [ ] **Step 5: Create the required short user-facing changeset through the project changeset workflow.** Do not run version or publish commands.
- [ ] **Step 6: Review final diff and status.** Confirm no package versions or release changelogs changed; remove only temporary files created by this work; leave unrelated files untouched; explicitly list later 2.6.3 tranches as unfinished.
