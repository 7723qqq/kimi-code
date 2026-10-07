# Progress

## Investigation — complete

Root causes (RC1–RC7) with citations are in requirements.md.

The previous round's diagnosis was wrong in the part that mattered. It treated `llmServerDecodeMs` as a
provider measurement that providers sometimes omit, and patched the omission with a hand-picked
plausibility ceiling. Following the field to its producer shows it is not a measurement of decode at all:

- `packages/kosong/src/generate.ts:140-209` — the first part's arrival is recorded but **not** added to
  `serverDecodeMs` (`:147-151`), and the wait from the last processed part to stream end **is** (`:205`).
- `packages/kosong/src/provider.ts:226-242` documents it as "server + network", notes a GC pause lands in
  it, and gives it a diagnostic purpose (`clientConsumeMs` share) — not a rate purpose.
- `model-requester.ts:23-31` keeps `streamDurationMs` mandatory, so providers without parts fall back to
  an even coarser span.

The denominator and the token count never covered the same interval. No ceiling can correct a bias whose
size varies per response.

## Approach — selected: live rate + web correction

Endpoint-bracketed, token-weighted sampler measured in the TUI; upstream `serverDecodeMs` left untouched
for its diagnostic consumer. Options B (session-average) and C (defer the web fix) were not selected.

## Implementation — complete

### T1/T2 — the sampler (`apps/kimi-code/src/tui/utils/token-speed.ts`, rewritten)

`TokenSpeedSampler` with an injectable clock, `measureStep` as a pure exported function, and `discardStep`
for a step that never closed its window. Deleted outright, not kept alongside: `pickDecodeMs`,
`computeSmoothedTokenSpeed`, `isPlausibleSample`, `MIN_STREAM_WINDOW_MS`,
`MAX_PLAUSIBLE_TOKENS_PER_SECOND`.

The window is `usageAtMs - firstPartAtMs`. Both head and tail fall outside by construction — the endpoints
are chosen so the interval brackets the tokens, rather than a correction applied afterwards.

### A correction found while implementing: the evidence floor

The first implementation of token-weighted smoothing had a real flaw, caught by a test I wrote with the
wrong expectation. Measured against a settled 125 tok/s readout:

| Burst sample | Effect on the readout |
| --- | --- |
| 1 token @ 5000 tok/s | +9.8% |
| 5 tokens @ 5000 tok/s | +48.7% |
| 100 tokens @ 5000 tok/s | +787% |

Proportional weight is necessary but not sufficient: a step's *rate* is `1 / window`, so short steps have
inflated rates and their (small) weight still multiplies an extreme value. `MIN_SAMPLE_TOKENS = 20` was
added: below it a step contributes neither a rate nor weight, and the readout holds. Twenty is the
smallest count whose window can be a plausible decode interval rather than a measurement artifact.

The failing test was corrected to assert the true behavior, and the reasoning is in the module docstring
rather than only in the test.

### T3 — the event path

- `session-event-handler.ts`: `handleAssistantDelta` and `handleThinkingDelta` call
  `noteStepStreamPart()` (first part opens the window; later parts are no-ops, so nothing is buffered);
  `handleStepBegin` calls `noteStepBegin()` so a cancelled step cannot leave a window open;
  `handleStepCompleted` calls `noteStepCacheStats(usage)`.
- `kimi-tui.ts`: `noteStepCacheStats` keeps the cache-token accounting unchanged and closes the step;
  `resetTokenSpeed()` delegates to `sampler.reset()`.

### T4 — ownership

`tokenSpeedEma` is gone; the sampler owns the rate, the weight and the reset rule.
`SessionReplayHost` gained `resetTokenSpeed`, called from `hydrateFromReplay`. The three boundaries
(session switch/startup, `/undo`, replay) are unchanged in count but now express session lifecycle.

### T5 — drop priority

Re-derived: turn/step counters 1, tools/LLM/in-out 2, first-token avg 4, **tok/s 5**, cache hit and
context `Infinity`. The rule is in the comment: information a later render cannot reconstruct outranks
decorations, and live information outranks both. Measured before/after at width 62 — the width where the
old ranking dropped it — the line is now `107 tok/s | cache hit 88% | context: 11% (104k/954k)`.

### T6 — the web readout

The web denominator had the same defect: `apps/kimi-web/src/lib/sessionStats.ts:142-145` accumulated
`llmStreamDurationMs`. Its fix needed two new timestamps on the wire, added at every hop:

| Hop | File |
| --- | --- |
| source | `packages/agent-core-v2/src/llm-adapter/model/model-requester-impl.ts` (`buildStreamTiming`) |
| contract | `.../llm-adapter/model/model-requester.ts` (`ModelRequestTiming`) |
| event | `packages/agent-core-v2/src/agent/loop/turnEvents.ts` |
| loop event | `packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts` (`step.end`) |
| emit | `packages/agent-core-v2/src/agent/loop/loopService.ts:1825,1846` |
| transcript | `packages/transcript/src/model/turn.ts`, `src/contract/schema.ts` |
| server map | `packages/kap-server/src/services/transcript/coreEventMap.ts` |
| protocol | `packages/kap-server/src/protocol/events-zod.ts` |
| consumer | `apps/kimi-web/src/lib/sessionStats.ts` |

A step missing either endpoint is skipped as a pair — counting its tokens without its time would bias the
average. The remaining difference between the two readouts is window length (recent rate vs session
cumulative), which is what R7 asked for.

## Verification

| Check | Result |
| --- | --- |
| `bun run typecheck` (repo-wide, final) | passes, no error lines |
| `bun run --filter '@moonshot-ai/kimi-code' test` | 18153 passed, 81 skipped, 0 failed |
| `bun run --filter '@moonshot-ai/kimi-web' test` | 40 files, 721 tests passed |
| `bun run --filter '@moonshot-ai/transcript' test` | 2 files, 158 tests passed |
| `token-speed.test.ts` | 18 tests, rewritten against the sampler |
| `kimi-tui-message-flow.test.ts` | 297 tests, incl. 5 speed cases |
| `footer-session-stats.test.ts` | 4 tests, narrowing order re-pinned at the same widths |

Regressions found and fixed during verification: the four `buildStreamTiming` snapshots (new fields), the
loop snapshot volatile-key list, and eight controller test hosts missing the two new mock methods. All
were mine, all are fixed; no pre-existing failure was suppressed.

### Manual scenario — not verified

No interactive TUI session against a real provider was run, so the live behavior is covered only by the
unit and harness tests. Said plainly rather than substituting a mocked stream for a live claim.

### RC1 before/after, on paper

A response whose first part arrives and whose usage frame follows 1000 ms after the last token, reporting
100 tokens:

- **Before**: denominator = observed span minus head, including the 1000 ms tail. At a true 125 tok/s the
  readout reported roughly 125 × (800 / 1800) ≈ 56 tok/s when the head wait was 0, and could read high
  when the tail was short — the error moved with the response, which is why no constant fixed it.
- **After**: the window is first part → usage frame, ending when the provider stopped counting. The same
  response reports the rate it actually achieved over the interval the tokens were produced in.
