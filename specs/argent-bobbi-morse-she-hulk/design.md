# Design — Measure the stream where it is observable

Audit citations live in requirements.md; this document assumes them.

## The decision that drives everything: measure in the TUI, not upstream

RC1's fix could be attempted upstream — re-define `serverDecodeMs` to exclude the tail and include the
head — and that is rejected outright: those fields have a diagnostic consumer (`provider.ts:232-235`,
the `clientConsumeMs` share) that depends on their current shape, and re-defining them would silently
change the meaning of data other code already reads. The readout's denominator is instead measured by a
component that already receives every event about the step and can time them itself.

The TUI has that vantage point. `session-event-handler.ts` handles every event of the turn; what it lacks
today is the *arrival time* of the parts and the usage frame that carries the token count. The design
adds exactly that one observation and builds the readout on it.

## The measurement (R1, R2)

A single new module, `apps/kimi-code/src/tui/utils/token-speed.ts` rewritten as a stateful sampler rather
than two free functions:

```ts
export interface TokenSpeedSample {
  readonly outputTokens: number;
  readonly windowMs: number;
}

/** Observes one step's stream and produces a rate for it.
 *  - `notePart(atMs)` is called for every streamed part; the first call opens
 *    the window.
 *  - `noteUsage(atMs, outputTokens)` closes it when the usage frame arrives.
 *  - A step whose stream never produced a part, or whose usage arrived before
 *    any part, yields no sample rather than a guessed one. */
export function measureStep(samples: readonly { atMs: number }[], usageAtMs: number | undefined,
                            outputTokens: number): TokenSpeedSample | null;
```

The window is `usageAtMs - firstPartAtMs`. Both endpoints are chosen so the interval brackets the tokens:
the first part is the earliest moment decoded tokens can exist, and the usage frame is emitted once the
provider has finished counting them. Both the head wait and the tail wait fall outside it by
construction — which is R2, and it is a property of *where the endpoints are taken*, not a correction
applied afterwards.

Provider-side honesty: if the provider sends the usage frame before any content part (some batch APIs
put usage in the last frame with the content, others send a final accounting frame), `usageAtMs` precedes
`firstPartAtMs` and the step yields `null`. So does a step with no parts at all. The readout then keeps
its previous value; it does not invent one.

## Smoothing (R5)

Replace the fixed-α EMA with a **token-weighted blend**: the window's rate enters with weight proportional
to the tokens it covered, against a decay factor over accumulated weight.

```
rate_new = (rate_prev * w_prev * DECAY + instant * tokens) / (w_prev * DECAY + tokens)
w_new    = w_prev * DECAY + tokens
```

- The first sample initializes outright (no blend against an undefined baseline).
- `DECAY` (0.8) is the only tuning constant, and it is dimensionless: "how much does evidence from a
  thousand tokens ago count". There is no α to justify and no `MIN_STREAM_WINDOW_MS` /
  `MAX_PLAUSIBLE_TOKENS_PER_SECOND` pair, because a sample's influence is now proportional to the
  evidence behind it — a collapsed 30 ms burst of 100 tokens carries 100 tokens of influence but a
  plainly worse rate, and a 3-token step barely moves anything. This is what R3 asked for: the guard is
  derived from the data instead of a ceiling.
- One ceiling survives, and it is not a transport heuristic: a provider that reports `outputTokens`
  larger than any model can decode in the observed window is reporting nonsense (a counter reset, a
  reused stream id). Samples above a named `IMPLAUSIBLE_RATE_CEILING` are dropped and the reason is
  documented as "the token count or the window is wrong", never "the provider was fast".

## Ownership and lifetime (R4)

The sampler is a small class with its own lifecycle:

```ts
export class TokenSpeedSampler {
  openStep(atMs: number): void;              // first part of a step
  closeStep(atMs: number, tokens: number): TokenSpeedSample | null;
  reset(): void;                             // lifetime boundary
  current(): number | null;                  // the smoothed rate, for rendering
}
```

`reset()` is called from the same three boundaries the previous round wired by hand, but the call sites
now express *session lifecycle* rather than "also remember to clear the speed":

- `resetSessionRuntime()` — session switch and startup.
- `noteContextCut()` — `/undo`.
- `SessionReplayRenderer.hydrateFromReplay` — replay.

The sampler replaces `tokenSpeedEma` under its own name; `AppState.tokenSpeed` stays as the rendered
number so the footer contract is unchanged.

**Note on the previous round's work**: `resetTokenSpeed()`, `resetTokenSpeedEma()` and the three call
sites survive in spirit and are rewritten in terms of the sampler; `isPlausibleSample` and
`pickDecodeMs` are deleted, not extended — they exist to sanitize a quantity this design no longer reads.

## Drop priority (R6)

Re-derived from what a user loses, not from the previous ordering:

| Item | Priority | Why |
| --- | --- | --- |
| `tok/s` | 5 | It is the reason many users keep the stats row visible at all; losing it makes the row pointless for them. |
| first-token avg | 4 | Latency detail; the live phase indicator already covers the perceived wait. |
| LLM time | 3 | A session total that grows slowly; the least informative per-glance. |
| tools time | 2 | Same. |
| in/out tokens | 2 | Static-ish totals. |
| turns/steps | 1 | Decorative counters. |
| cache hit, context | `Infinity` | Unchanged: they are the row's other reason to exist. |

The rule this encodes: **live, unrecoverable-from-later-renders information outranks cumulative totals**.
The previous ranking had it exactly inverted for `tok/s`. `footer-session-stats.test.ts:80-100` pins the
old order and will be rewritten to pin the new one, at the same widths, so the change is visible.

## The two readouts (R7 — this round or next, per the user's decision)

Under either answer the TUI stops consuming `serverDecodeMs`. If the web side is corrected in this round,
`apps/kimi-web/src/lib/sessionStats.ts` accumulates `decodeTokens` and a **measured window** over the same
rule (sum of per-step windows, only for steps that reported one) instead of dividing by the
`decodeMs` sum this repo accumulated before. The remaining difference — TUI shows the recent rate, web shows the session average — is
then a difference in *window*, which the docstrings state in one sentence each.

## Rejected alternatives

**A1 — re-define `serverDecodeMs` upstream to exclude the tail.** Smallest conceptual change and wrong:
it changes a diagnostic field's meaning for its existing consumer, edits the provider hot path, and
still measures event spacing rather than the token interval.

**A2 — keep the existing denominator and add another plausibility ceiling.** This is the previous round,
generalized. It treats a systematic bias as an outlier problem; no ceiling can correct a tail share that
varies per response.

**A3 — count tokens against a wall-clock window in the TUI (rolling window over part arrivals).** This was
option B last round. It cannot collapse, but it measures *observed* throughput including network stalls
the user did not ask about, and it needs a time source in a pure module. The endpoint-bracketed window
above gets the same robustness for the honest case while keeping the interval tied to the tokens.

**A4 — session cumulative rate in the TUI (matching web).** Stable, trivially explainable, and it stops
responding to the reply in flight — the last thing a user watching a long generation wants. Offered to
the user as the alternative meaning of the number, not as the default.

## Constraints

- The new module must be testable with an injected clock (`now`), like `createTimingPlugin`
  (`packages/agent-core-v2/src/human/timing/plugin.ts:17`) — no `Date.now()` calls that tests cannot
  control, and no fake timers in the suite.
- `session-event-handler.ts` must gain the part-arrival observation without buffering parts (the live
  render path is hot): only the first arrival time per step and the usage arrival time are kept.
- `AppState.tokenSpeed: number` stays; the footer's `> 0` gate and `formatTokenSpeed`'s thresholds are
  unchanged.
- Where a pinned test encodes the old behavior (`token-speed.test.ts` wholesale,
  `footer-session-stats.test.ts:80-100`), it is rewritten with the intent change stated in the task.

## Verification strategy

- `token-speed.test.ts`: rewritten against the sampler — head/tail exclusion (a step whose usage arrives
  100 ms after the last part must not count those 100 ms), the `null` cases, the token-weighted blend
  (a 500-token sample must move the rate further than a 5-token one), reset semantics.
- `footer-session-stats.test.ts`: the narrowing cases re-pinned at the same widths, asserting `tok/s`
  survives where it previously vanished.
- `kimi-tui-message-flow.test.ts`: the three reset/guard cases from last round, re-expressed against the
  sampler.
- A new handler-level test: a synthetic step whose parts and usage are fed at controlled timestamps must
  produce the exact expected `appState.tokenSpeed`.
- Repo commands per DEVELOP.md (`bun run typecheck`, per-package `bun run test`), not ad-hoc scripts.
