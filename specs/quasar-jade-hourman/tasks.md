# Tasks: 2.6.3 Request-Correctness Alignment

All source/test paths below are relative to `packages/agent-core-v2/`. Run package-scoped commands from that directory; repository checks state their root working directory explicitly. Implement and verify tasks sequentially, preserving the five upstream behaviors in `requirements.md`.

## 1. Prove and complete deferred-tool inline fallback

Files: `src/agent/toolSelect/toolSelectService.ts`, existing `test/agent/toolSelect/toolSelectService.test.ts` and `test/agent/llmRequester/llmRequesterService.test.ts`.

- [x] Add request-resolution coverage with eligible builtin, deferred user and MCP tools, including an unloaded MCP tool, while `dynamically_loaded_tools` is false.
- [x] Assert the outgoing request includes the eligible tools exactly once, excludes `select_tools`, and contains no `deferred: true` markers. Disabled/denied tools remain absent.
- [x] Cover switching models between turns from dynamic to non-dynamic disclosure. Assert on the tools actually sent to the provider; historical schema messages, registry definitions and the persisted initial tool snapshot remain unchanged. Explicit caller tool selections retain their existing behavior.
- [x] Run the regression before changing production code. Repair only uncovered behavior, or retain the already-equivalent path and record evidence.
- [x] Run `bun test --isolate test/agent/toolSelect/toolSelectService.test.ts test/agent/llmRequester/llmRequesterService.test.ts`.

Acceptance: the assertions above pass and existing dynamic-disclosure/schema-pinning cases remain green.

## 2. Reject repeated responses on both settlement paths

Files: `src/human/llm/empty-response.ts`, `src/human/agent/turn.ts`, `src/llm-adapter/model/model-requester-impl.ts`; existing empty-response, kernel-turn and model-requester test files.

- [x] Add failing cases with visible text and with a complete tool call, both carrying `rawFinishReason: 'repeat'`.
- [x] Assert `kind: 'empty_response'`, `retryable: true`, preserved raw reason, and a diagnostic naming repeated output. The kernel must not execute a tool from the rejected response.
- [x] Preserve ordinary completed text/tool-call success and non-retryable filtered empty responses.
- [x] Place the repeated-response check before tool-call success in kernel settlement and use the same pure rule in the model adapter.
- [x] Run `bun test --isolate src/human/test/llm/empty-response.test.ts src/human/test/agent/turn.test.ts test/llm-adapter/model/modelRequester.test.ts`.

Acceptance: neither settlement path reports a repeated response as successful; normal success and filtering behavior remain green.

## 3. Reject EOF without a finish event and preserve retry isolation

Depends on task 2's shared terminal-outcome rule.

Files: the two settlement consumers and shared validator above; existing `src/human/test/agent/turn.test.ts`, `test/llm-adapter/model/modelRequester.test.ts`, `src/human/test/llm/fast-upstream.test.ts`, and `test/helpers/mockUpstream.ts` only if the existing fixture needs a new response scenario.

- [x] Add failing streaming cases for nonempty text, whitespace-only text and an unfinished tool-call argument followed by EOF without a finish event.
- [x] Assert a retryable provider failure identifying the missing finish event; there is no successful final model result and no unfinished tool execution. Keep empty/reasoning-only failure classification intact.
- [x] Exercise a controlled first incomplete attempt followed by a completed attempt through existing retry orchestration. Assert the final successful answer contains only the completed attempt's text/tool arguments, not concatenated partial output.
- [x] Verify ordinary finish events and caller cancellation still terminate correctly; reset finish-observation state on every new attempt. Do not add a public non-streaming configuration option.
- [x] Run `bun test --isolate src/human/test/agent/turn.test.ts test/llm-adapter/model/modelRequester.test.ts src/human/test/llm/fast-upstream.test.ts`.

Acceptance: both direct kernel and model-adapter consumers reject missing-finish streams, the real-socket case reproduces the EOF boundary, and retry/cancellation tests pass without increasing retry or timeout defaults.

## 4. Retain first-choice OpenAI usage in the base protocol

Files: `src/human/llm/requester/bases/openai/contract.ts`, `format.ts`, `src/human/llm-kimi/trait.ts`; existing usage, trait and real-socket tests.

- [x] Add failing base OpenAI cases with choice usage `{ prompt_tokens: 5, completion_tokens: 1 }` and absent/null top-level usage. Assert one usage result with inputOther 5, output 1, inputCacheRead 0 and inputCacheCreation 0 under the fork's existing accounting contract.
- [x] Supply contradictory top-level usage `{ prompt_tokens: 120, completion_tokens: 30 }`; assert it wins and is not added to choice totals. A top-level empty object is not replaced by the choice.
- [x] Verify chunks lacking both locations emit no usage; existing cache-split tests remain unchanged.
- [x] Move the fallback to the base parser and retire redundant Kimi-specific fallback logic while retaining the provider extension point.
- [x] Exercise a choice-usage response through the existing real-socket requester fixture.
- [x] Run `bun test --isolate src/human/test/llm/usage.test.ts src/human/test/llm/trait.test.ts src/human/test/llm/fast-upstream.test.ts`.

Acceptance: ordinary OpenAI-compatible and Kimi requesters retain choice usage with top-level precedence, without duplicate accounting.

## 5. Prove retry-then-overflow compaction recovery

Files: `src/agent/loop/loopService.ts`, `src/agent/loop/machine/engine.ts` only if the regression reveals a gap; existing `test/agent/fullCompaction/fullCompaction.test.ts` and `test/agent/loop/loop.test.ts`.

- [x] Extend the provider-overflow scenario with a deterministic sequence: retryable 429, context overflow, successful compaction summary, successful final answer. Include the request-sent events that production emits.
- [x] Assert exactly four provider invocations in that fixture, automatic compaction started/completed, the pending user prompt survives, the recovery answer is retained, and the original turn ends completed rather than hanging or ending failed.
- [x] Assert projected request/step records associate both the failed attempts and successful answer with the active turn; do not duplicate a begin for an already-open attempt. Check live/cold replay agreement with the existing resume helper.
- [x] Preserve the fork's configured max-step cap, ordinary retry numbering and cancellation behavior. Repair missing step state at the existing gate/projection boundary only if tests demonstrate it; otherwise record equivalence.
- [x] Run `bun test --isolate test/agent/fullCompaction/fullCompaction.test.ts test/agent/loop/loop.test.ts`.

Acceptance: the sequence completes with the four expected calls and replay-equivalent history; existing retry, step-budget and cancellation coverage remains green.

## 6. Verify the package deliverable and record tranche evidence

- [x] Run all focused tests from tasks 1–5 after the last production change.
- [x] Run `bun run test`, `bun run typecheck` and `bun run build` from `packages/agent-core-v2` sequentially; report every failure or capability skip relevant to this tranche.
- [x] From the repository root run `bun run check:boundaries`, `bun run check:no-comments`, scoped lint for the changed TypeScript files, and `git diff --check`. Apply any additional owning checks required by changed shared contracts under `CONVENTIONS.md`.
- [x] Update the existing upstream tracking surface with the five commit IDs, passing test probes and explicit ported/equivalent verdicts; use `.upstream/PLAYBOOK.md` for release-only provenance when the ledger has no supported row. Follow the project's changeset workflow for required user-visible notes.
- [x] Check the final diff and Git status. Remove only temporary files created by this task, keep unrelated work intact, and confirm package versions and release changelogs were not changed by this tranche.

Acceptance: focused and package verification passes on the final deliverable; every scoped upstream behavior has inspectable regression evidence; remaining 2.6.3 sub-projects are explicitly listed as unfinished. This task does not authorize a commit, push, publish, or edits for the later tranches.