# Design — Making the tok/s readout a measurement, not an estimate with a leak

Audit citations live in requirements.md; this document assumes them and does not repeat them.

## The key decision

The root cause of D1 is not the EMA — it is that the sanity check sits on the branch that almost never
runs. The fix belongs *behind* `pickDecodeMs`, expressed against the sample it divides, so that every
consumer of the helper gets the guarantee, not just the footer.

The three options below differ in what they do with an implausible sample, which is a product decision
about what the number means. The rest of the design (R3–R5) is common to all three.

## Common contract (all options)

`apps/kimi-code/src/tui/utils/token-speed.ts` grows one exported predicate and one exported reset, and
the caller gains the reset wiring.

```ts
/** Plausibility floor for a decode window: rates above this cannot be a real
 *  model decode and mean the window collapsed, not that the model was fast. */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1500;

/** True when `outputTokens / decodeMs` is a rate a real model can produce. */
export function isPlausibleSample(outputTokens: number, decodeMs: number): boolean;

/** The readout's lifetime: called on session switch / clear / replay start. */
export function resetTokenSpeedEma(): null;
```

`computeSmoothedTokenSpeed` keeps its signature (`types.ts:78` and the footer are unchanged) and gains
the plausibility check alongside its existing viability checks — an implausible sample returns `prev`,
exactly like a zero-token step and a null window do today. `MIN_STREAM_WINDOW_MS` remains the fallback
path's guard and remains exported (R6: `token-speed.test.ts:10-20` pins it).

`kimi-tui.ts`: `noteStepCacheStats` is unchanged; a new `resetTokenSpeed()` sets
`this.tokenSpeedEma = null` and patches `tokenSpeed: 0` — the same shape as the existing cache-counter
resets, so the footer's existing `tokenSpeed > 0` gate (`footer.ts:498`) suffices to hide the readout
until the next usable step.

The threshold is stated in tok/s rather than in ms deliberately: the burst is a property of the *rate*
(a 30 ms window for 5 tokens is fine; for 500 tokens it is not), so a millisecond constant applied to
both paths cannot express it. 1500 sits above frontier-model decode rates and below burst artifacts;
it is a single named export so a future measurement can lower it in one place.

## Option A — reject implausible samples (recommended)

The predicate above, applied on both paths, plus R3/R4/R5.

- Burst sample → `isPlausibleSample` false → EMA keeps `prev` (or stays `null` on a first step) → the
  footer shows the last honest rate, or hides the readout if there never was one.
- The existing burst test (`token-speed.test.ts:68-88`) inverts: the 30 ms / 100-token sample no longer
  initializes the EMA, so the test is rewritten to assert the burst is *rejected* and that a following
  honest sample initializes cleanly.
- Smallest diff; no new state; no behavior change for providers that report sane windows.

Trade-off: a genuinely fast provider (> 1500 tok/s sustained, e.g. a small model on a warm cache) loses
its readout and shows the previous one. Accepted: the previous rate is a better answer than a fabricated
one, and the same trade was already made for the fallback window.

## Option B — stop deriving a duration, count tokens against a wall-clock window

Abandon `decodeMs` for the readout and measure over a rolling wall-clock window instead: keep the last
N ms of `(timestamp, outputTokens)` samples and divide the tokens in the window by the window's length.
This cannot collapse, because the denominator is the observer's clock, not the provider's event spacing,
and it is robust to batching by construction.

Trade-off: it needs a sample buffer and a time source in a module that is currently two pure functions,
it measures *observed* throughput (including network and client-consume time — the very thing
`serverDecodeMs` was invented to exclude), and it produces one number that ignores the provider's own
accounting. Larger diff, new failure mode (an idle gap inside the window drags the rate down).

## Option C — drop the EMA, show the session cumulative rate

Delete `computeSmoothedTokenSpeed` and mirror `apps/kimi-web/src/lib/sessionStats.ts:218-220`: divide
session-cumulative `decodeTokens` by session-cumulative `decodeMs`, exactly as Web already does.

Trade-off: it resolves D4 by definition rather than by documentation, and is trivially explainable. But
it is the session average, so it lags badly — a long session's early slowness never leaves the number,
and the readout no longer responds to the current reply at all. It also deletes a tested module.

**Recommended: A.** B and C are passed to ExitSpecMode as alternatives; the choice changes T1–T2 only,
T3–T5 are shared.

## R3 — the readout's lifetime (invariant wiring)

`tokenSpeedEma` is reset by the same three events that already reset the surrounding session state:

| Event | Reset point (to be added beside the existing session reset) |
| --- | --- |
| new session / session switch | the `sessionStats: createEmptySessionStats()` call path in `kimi-tui.ts` |
| `/clear` / `/undo` cut | the existing context-cut hook, `noteContextCut()` (`kimi-tui.ts:2675-2677`) |
| replay start | the existing `isReplaying` transition |

The rule is one line in `token-speed.ts`'s module docstring and one line in the `resetTokenSpeed`
comment: **the EMA lives in the session, not in the TUI process.**

## R4 — drop priority

Recommendation: **keep `priority: 3`** and extend the existing comment (`footer.ts:231-232`) with the
reason it ranks below session totals — the rate is a live, recoverable figure (it returns on the next
step), while LLM time, in/out and turn counts are cumulative facts that cannot be recovered from a
later render. No code change beyond the comment; `footer-session-stats.test.ts:80-100` already pins the
ranking and stays untouched.

## R5 — the two definitions

Add a docstring line to `token-speed.ts` and to `sessionStats.ts:217` naming the other implementation and
the difference in one sentence. This is the whole of R5 under options A and B; under option C the two
implementations converge and the docstrings say so.

## Constraints

- `computeSmoothedTokenSpeed` and `pickDecodeMs` stay pure and synchronously testable —
  `token-speed.test.ts` has no fake timers and should keep none.
- The i18n string `tui.chrome.footer.tokenSpeed` and `formatTokenSpeed`'s thresholds are unchanged
  (`formatTokenSpeed` already prints integers at >= 100, which is what a plausible rate now looks like).
- No new config key, no new footer slot, no change to `AppState`'s type.
- Behavior changes must be visible in the existing test files, not in new ones, wherever a pinned
  expectation inverts (R6).

## Verification strategy

- `apps/kimi-code/test/tui/utils/token-speed.test.ts`: the inverted burst case (accepts a sane sample,
  rejects the burst), the boundary at the new threshold, and the `prev`/`null` preservation.
- `apps/kimi-code/test/tui/components/chrome/footer-session-stats.test.ts`: unchanged, must stay green.
- A reset test at the `kimi-tui` level: feed a step, reset, assert `appState.tokenSpeed === 0` and that
  the next step initializes rather than blends.
- The repo's own commands — `bun run test` and `bun run typecheck` for the affected package — per
  DEVELOP.md; no ad-hoc scripts.
