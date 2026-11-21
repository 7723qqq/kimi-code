# Design: 2.6.3 Request-Correctness Tranche

## Approach

Port the five behaviors in `requirements.md` onto the fork's existing request pipeline. Use the release-tag implementation as behavioral reference but preserve this fork's machine loop and LLM layers. No public API or server wire contract changes are planned.

The pure LLM kernel stays inside `packages/agent-core-v2/src/human/`; v2 behavior belongs to the agent/loop and tool-select domains; `llm-adapter` owns the compatibility boundary. Apply the constraints in `CONVENTIONS.md`, `DEVELOP.md`, `src/human/AGENTS.md`, and `docs/en/llm.md`.

## Files and ownership

| Behavior | Production owner | Regression tests |
| --- | --- | --- |
| Deferred-tool fallback | `packages/agent-core-v2/src/agent/toolSelect/toolSelectService.ts` (`defaultToolsForDisclosure` / disclosure shaping) | `packages/agent-core-v2/test/agent/toolSelect/toolSelectService.test.ts` and `test/agent/llmRequester/llmRequesterService.test.ts` |
| Retry then context overflow | `packages/agent-core-v2/src/agent/loop/loopService.ts` (`gate`, `projectMachineEvent`) and existing machine event projection in `src/agent/loop/machine/engine.ts`, only if a failing test demonstrates the gap | `packages/agent-core-v2/test/agent/fullCompaction/fullCompaction.test.ts`, `test/agent/loop/loop.test.ts` |
| Repeated finish reason | `packages/agent-core-v2/src/human/llm/empty-response.ts`, reused by `src/human/agent/turn.ts` and `src/llm-adapter/model/model-requester-impl.ts` | `src/human/test/llm/empty-response.test.ts`, `src/human/test/agent/turn.test.ts`, `test/llm-adapter/model/modelRequester.test.ts` |
| Missing finish event | Shared pure completion validation in `src/human/llm/empty-response.ts`; invoke from kernel `src/human/agent/turn.ts` and `src/llm-adapter/model/model-requester-impl.ts` before success | The settlement tests above and `src/human/test/llm/fast-upstream.test.ts` |
| OpenAI choice usage | `src/human/llm/requester/bases/openai/contract.ts` and `format.ts`; remove duplicate choice-usage hoisting from `src/human/llm-kimi/trait.ts` | `src/human/test/llm/usage.test.ts`, `src/human/test/llm/trait.test.ts`, `src/human/test/llm/fast-upstream.test.ts` |
| Tranche release note | One patch changeset for `@moonshot-ai/kimi-code`, generated under the existing changeset workflow | No source test; verify its manifest parses and no version command is run |

All source/test paths in the table, except the changeset path, are relative to `packages/agent-core-v2/`.

## Decisions by behavior

### Deferred tools

Use the existing `defaultTools(disclosure)` decision; do not add upstream's `requestTools` API. When dynamic loading is unavailable, an eligible deferred tool is included in the provider-visible list with the display-only `deferred` marker removed. Keep `select_tools` filtered from non-disclosure tool lists. Preserve profile/permission filtering, explicit caller-supplied `overrides.tools`, dynamic retrieval, historical pinned schemas, and immutable registry/state data.

Verify eligibility in the actual provider request, not only in `shapeTools` or the tool snapshot log. `AgentLLMRequesterService` prepares the default list; `ModelRequesterImpl.wireTools` then drops entries still marked deferred. Keep the fallback in default-list projection for the selected model, not in a blanket change to `wireTools` that could expose explicitly deferred tools. Cover an eligible, unloaded MCP tool and a dynamic-to-static model transition between turns; if the current path already passes, keep it and record equivalence.

### Retry then overflow

`AgentLoopService.gate()` establishes the logical request step. `MachineEngine` maps `llm.sent` to `stepStarted`; retry/recovery returns control through the machine event path, then the loop retires failed attempt state. Extend the existing full-compaction regression to send a retryable 429 first and a context-overflow error second, followed by compaction summary and a successful answer. The fixture emits the same `llm.sent` lifecycle signal as production.

Only if the regression exposes missing projection state, repair `MachineStepState` initialization at the existing gate/projection boundary so `projectMachineEvent` can associate events with the active attempt. Pair each `step.begin` and `step.end` by that attempt's UUID. Do not open duplicate records for the same attempt or change the fork's retry numbering, step budget, failed-attempt telemetry, or replay pairing to match upstream's private implementation.

### Repeated and incomplete responses

Keep `emptyResponseError()` as the pure classification owner. A raw provider reason `repeat` is an empty-response failure before checking whether accumulated text or tool calls exist; retain the raw/normalized finish values and mark it retryable.

Add a pure completion validator with input `(message: AssistantMessage, model: LlmModel, finish: FinishInfo | undefined)` and result `LlmErrorMessage<'empty_response' | 'provider'> | null`. First run `emptyResponseError(message, model, finish ?? NO_FINISH)` to preserve empty and reasoning-only classification even without a finish event. If that check succeeds and the streaming attempt did not observe a finish event, return a retryable `provider` failure. A received `FinishInfo` with nullable fields is not the same as an absent event.

At kernel turn settlement, run validation before the `llm.done` branches that accept normal output or execute tool calls. At the model-event adapter, run the same validation before emitting a successful `finish` event. Keep finish-observation state scoped to one request attempt and clear it on retry. Let existing retry/error conversion own retries and cancellation. The standard local requester contracts are streaming; do not invent a non-streaming switch just to mirror the upstream source condition.

Regression coverage must include: partial text at EOF; complete text with `repeat`; a completed tool call with `repeat` that does not execute; whitespace-only and unterminated tool-argument streams; a completed response; filtered empty output; abort; and an incomplete first attempt followed by a completed retry whose final result excludes the discarded partial attempt. Use the existing local-server/mock stream helper where practical.

### OpenAI choice-level usage

Add `usage?: OpenAIRawUsage | null` to `OpenAIRawChunk.choices[]`. The base OpenAI parser resolves `chunk.usage ?? chunk.choices?.[0]?.usage`, then calls the existing `parseOpenAIUsage` once. Explicit top-level `{}` wins over choice usage, and no usage event is emitted if both fields are absent/null. Keep cache split validation/accounting unchanged.

Remove only the redundant Kimi override that duplicates the base OpenAI fallback; retain other Kimi trait hooks. Verify the raw usage and token counts through both direct parser tests and the shared mock-server protocol matrix.

## Release/tracking decision

This tranche changes CLI-visible failure/tool behavior, so record one short patch changeset for `@moonshot-ai/kimi-code`, using `.agents/skills/gen-changesets` before implementation. Do not change either package version or package `CHANGELOG.md`; `CONVENTIONS.md` requires this fork to follow upstream versions, and final release metadata sync is explicitly a later tranche. Record the five release-only behavior commits in the existing `.upstream/PLAYBOOK.md` release-difference section with test evidence. Do not fabricate mainline ledger rows: `scripts/upstream-ledger.mjs` discovers `upstream/main`, while these hashes come from the release-tag-only range.

## Alternatives rejected

- **Copy upstream files or adopt the upstream loop architecture:** those paths do not exist in this fork and would replace the established machine architecture rather than port the requested behavior.
- **Fix only the OpenAI/Kimi parser or only the model-event adapter:** leaves the kernel turn/tool-execution consumer able to accept the same invalid outcome.
- **Synthesize a finish event at EOF:** hides truncation and can authorize an incomplete answer/tool call.
- **Duplicate existing deferred-tool code without testing provider-visible behavior:** adds drift without proving the missing behavior.

## Later tranches

Task/Stop/Tower lifecycle, foreground-shell client event-origin routing, legacy-model/session/config/index recovery, Windows WebBridge, and final version/release-note synchronization remain separately scoped work. This specification only completes request correctness and must be reported as a partial 2.6.3 alignment.