# Progress

## Scope executed

T1–T5 and T8, per the approved option ("do T1–T5, T8; pick A or B later"). The live-rate *liveness*
question (option A vs B) is deliberately left open: what landed is the plumbing both options need plus
the accuracy gate, and the footer currently shows the step-rate reading that option A would use.

---

## T1 — the sampler's two figures (complete)

`apps/kimi-code/src/tui/utils/token-speed.ts`: added `stepTokensPerSecond(measurement)` beside
`tokensPerSecond(totals)`, and `TokenSpeedSampler` now returns a `TokenSpeedReadout`
(`{ step, average }`) from `addStep`/`current`. `reset()` clears both.

The step figure holds its previous value when a step cannot be measured, rather than blanking: the
reply it describes is still the most recent one. `null` never becomes `0`.

`token-speed.test.ts` is 20 tests. The five pre-existing sampler tests moved to the new return shape
with their assertions intact (same numbers, same intents) — the shape changed, not the contract.

## T2 — AppState (complete)

`AppState.tokenSpeed` keeps the step figure (its existing doc comment already described that
semantics); `tokenSpeedAverage` is new. Both are `0` for "no reading", matching the footer's existing
`> 0` gate so no `null` plumbing was needed. Five test fixtures gained the new field; keeping it
required made `tsc` name every fixture that needed it.

## T3 — rendering (complete)

`footer.ts` emits one segment holding both labels, and the locale keys are
`tokenSpeedStep` / `tokenSpeedAverage` (`{{speed}} tok/s now` / `{{speed}} tok/s avg`, and 当前/平均 in
Chinese) in `.ts` and `.json`.

**A design defect was found here and fixed.** The first version pushed two segments at
`priority: 5`. Measured at each width, `fitSessionStatsText` dropped them one at a time: at width 62–70
only `95 tok/s avg` survived, while `107 tok/s now` disappeared — the exact outcome R7 forbids, and the
survivor reads like the only answer. Joining them into a single segment fixes it: at 70 and below both
go together.

Widths measured with a throwaway probe against the shared fixture:

| width | what fits |
| --- | --- |
| 170 | all seven items |
| 95–130 | first-token avg + both rates + cache + context |
| 88–74 | both rates + cache + context |
| ≤70 | neither rate |

`footer-session-stats.test.ts` is 5 tests, pinning the 170/95/88/70 boundaries and the
never-split rule, plus the one-label case (a figure with no reading is omitted, not shown as zero).
`bun run check:locale-keys` and `bun run check:t-coverage` both pass.

## T4 — reset and partial steps (complete)

`kimi-tui-message-flow.test.ts` is 298 tests. The speed cases now assert both figures: a slow second
step drops the average toward it while the step figure reports that step alone; a reset clears both and
the next step reports its own rate rather than one blended with the previous session's; a single-token
step leaves the step figure standing.

## T5 — live-provider verification (complete, with one budget row at its edge)

`probe-two-rates.mjs` replays the shipped arithmetic against MiniMax-M2 and compares it with the
provider's own count over the streamed span. Two runs, six and ten samples:

| reply | 6 samples | 10 samples | budget |
| --- | --- | --- | --- |
| ~900 tok | 0.62% | 0.68% | ±0.9% |
| ~300 tok | 1.89% | 1.85% | ±2.5% |
| ~120 tok | 9.75% | 8.96% | ±10% |
| ~24 tok | **36.77%** | 32.99% | ±35% |

Every run produced a measurable window (`n=6/6`, `n=10/10`) — no run was filled with a guess.

**The ~24-token row is not stable**: 36.77% on one run, 32.99% on the next, against a ±35% budget. It
straddles the line rather than clearing it, which is the measurement the budget was there to catch.

### What was done about it

Rather than widen the budget — which would be tuning the criterion to the result — R4 was applied: a
step window shorter than `MIN_STEP_WINDOW_MS = 500` yields no step rate, and the footer holds the
previous figure instead of showing one that can be 37% out.

The threshold is read off these measurements, not chosen for convenience: 500 ms is about a 120-token
reply, measured at 8.96% error; 300 ms is about 24 tokens, measured at 33–37%. Boundary tests pin 499
as withheld and 500 as reported.

The session average is deliberately **not** gated by this: it accumulates the same windows, so its
error shrinks as the session grows instead of depending on the step just closed.

## T8 — documentation and changeset (complete)

- `token-speed.ts` documents both figures' contracts, the window floor with the measurements behind
  it, and points at the accuracy budget rather than restating a claim.
- `.changeset/*.md` added for `@moonshot-ai/kimi-code` per `.changeset/README.md`.
- The footer's drop-priority comment now describes the pair as one slot.

## Not done, and why

- **Option A vs B** (step rate vs a mid-stream provider count) was explicitly deferred by the approved
  scope. What shipped is the plumbing plus the gate. The footer's step figure is the step that just
  closed, so within a single long step it does not move — option B is what makes it move, and it needs
  a wire field.
- **The unverified case stands**: no run produced a buffered delivery (a provider that assembles the
  whole reply before sending it). The +647%–+7375% failure mode recorded in
  `token-speed-accuracy.test.ts` therefore remains untested against a live endpoint.

## Verification

| check | result |
| --- | --- |
| `token-speed.test.ts` | 20 passed |
| `footer-session-stats.test.ts` | 5 passed |
| `kimi-tui-message-flow.test.ts` | 298 passed |
| `bun run check:locale-keys` | all locale keys consistent |
| `bun run check:t-coverage` | all t() calls have matching keys |
| `tsc -p apps/kimi-code/tsconfig.json --noEmit` | clean |
| `probe-two-rates.mjs` (live provider) | 3 of 4 rows within budget; the 4th prompted the window floor |
