# Progress

## Investigation — complete

Full data path with citations is in requirements.md; not repeated here.

### What the module did

`apps/kimi-code/src/tui/utils/token-speed.ts` (80 lines, two pure functions) computed a step-level
tokens/second readout for the footer.

### What the number is made of

`serverDecodeMs` is accumulated in `model-requester-impl.ts:228-241` and closed at `:266-271` as a sum of
**inter-arrival gaps between SSE parts**, minus the client's own consume time. The same shape exists in
the human timing plugin (`packages/agent-core-v2/src/human/timing/plugin.ts:26-91`). The module's
docstring called it "the provider-reported time it actually spent generating", which it is not.

### Parallel implementation

`apps/kimi-web/src/lib/sessionStats.ts:218-220` computes `decodeTokens / decodeMs * 1000` over session
cumulative totals — no EMA, no plausibility guard — and formats it with different thresholds
(`:239-242`, one decimal below 10 vs the TUI's below 100).

## Approach — selected: A (reject implausible samples)

Options B (rolling wall-clock window) and C (session cumulative rate) were presented and not selected.

## Implementation — complete

### T1/T2 — the plausibility contract (`token-speed.ts`)

- Added `MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1500` and `isPlausibleSample(outputTokens, decodeMs)`; the
  guard is expressed in tok/s, the unit displayed, because plausibility depends on the token count as
  well as the window (30 ms is ample for 5 tokens, absurd for 500).
- `computeSmoothedTokenSpeed` returns `prev` for an implausible sample, so a burst neither initializes
  nor dilutes the EMA.
- `pickDecodeMs` gained a required third argument, `outputTokens`: a collapsed server decode window is
  now rejected on the path that actually runs, not only on the fallback. The token count is required
  context — the ceiling scales with it — rather than an optional tie-breaker.
- The module docstring no longer claims `serverDecodeMs` is a provider measurement, and states the
  lifetime rule and the divergence from the web readout.

### T3 — the readout's lifetime

`resetTokenSpeedEma()` in `token-speed.ts` returns `null`; `KimiTUI.resetTokenSpeed()` assigns it and
patches `tokenSpeed: 0`. Wired at the three session boundaries:

| Point | Location |
| --- | --- |
| session switch / startup | `resetSessionRuntime()`, `kimi-tui.ts:2025` |
| `/undo` context cut | `noteContextCut()`, `kimi-tui.ts:2685` |
| replay hydration | `SessionReplayRenderer.hydrateFromReplay`, `session-replay.ts:123` (new `resetTokenSpeed` member on `SessionReplayHost`) |

### T4 — drop priority

Kept `priority: 3` and recorded the reason beside the ranking in `footer.ts:225-238`: the rate is live and
recoverable, while LLM time, token counts and turn/step counters are cumulative facts a later render
cannot reconstruct.

### T5 — the two definitions

Each implementation's docstring now names the other file and the difference (step-level EMA vs session
cumulative ratio). Comments only; no behavior change.

## Verification

| Check | Result |
| --- | --- |
| `bun run typecheck` (repo-wide) | passes, no error lines; every package exits 0 |
| `bun run --filter '@moonshot-ai/kimi-code' test` (full) | 18150 passed, 1 failed — see below |
| `bun run --filter '@moonshot-ai/agent-core-v2' test` (full, isolated) | 429 files passed, 7695 tests passed |
| `bun run --filter '@moonshot-ai/kimi-web' test` | 40 files, 720 tests passed |
| `token-speed.test.ts` | 18 tests (was 13) |
| `kimi-tui-message-flow.test.ts` | 295 tests, including the three new reset/guard cases |

The single failure in the repo-wide run is
`packages/agent-core-v2/test/features/tower/towerService.test.ts:931` — an assertion that two skip-log
messages arrive in a fixed order. It passes when `agent-core-v2` runs alone, so it is an ordering
flakiness across packages, unrelated to this change; that file and package were not modified.

New behavior tests: the burst case in `token-speed.test.ts` is **inverted** (it used to assert the burst
was accepted at > 3000 tok/s and is now asserted to be rejected), plus the ceiling boundary, the
token-count scaling of the ceiling, and three `kimi-tui-message-flow` cases covering reset-on-switch,
reset-on-undo, and a collapsed window leaving the readout hidden.

### Manual scenario — not verified

The task asked for a live stream from a real provider to confirm a stable footer `tok/s`. No interactive
TUI session against a real provider was run from here, so **this check is unverified**; the behavior is
covered only by the unit and harness tests above. It has not been substituted with a mocked stream claim.
