# Tasks

Approach from design.md: an endpoint-bracketed, token-weighted sampler owned by the TUI. Each task names
the check that must fail before the change and pass after. Run the repo's own commands per DEVELOP.md
(`bun run typecheck`, per-package `bun run test`) — not ad-hoc scripts.

## T1 — Replace the module with a sampler (R1, R2)

Rewrite `apps/kimi-code/src/tui/utils/token-speed.ts` as `TokenSpeedSampler` per design.md: `openStep`,
`closeStep`, `current`, `reset`, an injectable clock, and the window `usageAtMs - firstPartAtMs`.
`pickDecodeMs`, `computeSmoothedTokenSpeed`, `isPlausibleSample`, `MIN_STREAM_WINDOW_MS` and
`MAX_PLAUSIBLE_TOKENS_PER_SECOND` are deleted rather than kept alongside.

**Acceptance criteria**

- With an injected clock: parts at t=0 and t=200, usage at t=800 with `outputTokens: 100` yields exactly
  `125 tok/s` (100 tokens / 800 ms). A test that instead feeds the old `serverDecodeMs` shape
  (200 ms of gaps) must produce `500`, proving the denominator is no longer the gap sum — both cases
  pinned, so a regression to the old source fails loudly.
- Head exclusion: parts at t=1000 and t=1200, usage at t=1800 → the window is 800 ms, not 800 minus the
  1000 ms head wait.
- Tail exclusion: parts at t=0 and t=200, usage at t=900, but the stream's last event at t=1900 →
  still 800 ms. The 1000 ms of post-usage idle must not enter the window.
- `closeStep` before any `openStep` returns `null`; `closeStep` with `outputTokens: 0` returns `null`;
  a step with parts but no usage frame returns `null` and leaves `current()` unchanged.
- `reset()` makes `current()` `null`; a `closeStep` after a reset initializes rather than blending.
- `bun run --filter '@moonshot-ai/kimi-code' test` passes for the unit file;
  `bun run typecheck` passes (will require T3's caller update in the same change).

## T2 — Token-weighted smoothing (R3, R5)

Implement the blend in design.md: influence proportional to the sample's token count, one dimensionless
`DECAY`. Keep exactly one ceiling (`IMPLAUSIBLE_RATE_CEILING`) and document it as "the token count or the
window is wrong", not as a transport heuristic.

**Acceptance criteria**

- A 500-token sample moves `current()` at least 10× as far as a 5-token sample from the same starting
  value — the property the fixed-α EMA violated.
- A 5-token step reading 4000 tok/s (short burst) moves a settled 120 tok/s readout by less than 5%,
  where the old α = 0.4 blend moved it by more than half. Fails on the previous implementation.
- After 20 identical 100-token/800 ms samples, `current()` is within 1 tok/s of 125.
- A sample above `IMPLAUSIBLE_RATE_CEILING` is dropped and `current()` is unchanged; the docstring states
  the ceiling bounds the *plausibility of the report*, with the token count named as a possible culprit
  alongside the window.
- No test references `EMA_ALPHA`, `MIN_STREAM_WINDOW_MS` or `MAX_PLAUSIBLE_TOKENS_PER_SECOND` — grep for
  each returns zero hits in `apps/kimi-code/`.

## T3 — Feed the sampler from the event path (R1, R2)

In `session-event-handler.ts`, record the first part arrival and the usage arrival for the step in
flight, and close the step on `turn.step.completed`. In `kimi-tui.ts`, `noteStepCacheStats` keeps its
cache-token accounting and hands the closed sample to the sampler; `AppState.tokenSpeed` is patched from
`sampler.current()`.

**Acceptance criteria**

- A handler-level test feeds parts at controlled timestamps and a usage frame, then asserts
  `appState.tokenSpeed` equals the exact expected rate for that window. A second case with a different
  usage timestamp yields a proportionally different rate — proving the window, not a constant, drives it.
- The cache-token accounting in `noteStepCacheStats` (`kimi-tui.ts:2602-2619`) is byte-for-byte preserved
  in behavior: the existing cache-hit tests pass unchanged.
- A step that produces no parts (a pure tool-call step) leaves `appState.tokenSpeed` untouched, and one
  test asserts the value stays at the previous rate rather than dropping to 0.
- No part payloads are retained: the handler stores only timestamps. A test asserts the retained state
  for a step is a fixed number of scalars, not a growing array.

## T4 — Sampler ownership and lifetime (R4)

Move the smoothing state and the reset rule into the sampler; rewrite `resetTokenSpeed()` as a thin
delegation and re-express the three boundaries (`resetSessionRuntime`, `noteContextCut`,
`hydrateFromReplay`) as session-lifecycle events.

**Acceptance criteria**

- The three existing `kimi-tui-message-flow.test.ts` cases (reset on switch, reset on `/undo`, collapsed
  window leaves the readout hidden) pass in their rewritten form; the first two assert `tokenSpeed === 0`
  after the boundary and that the next step initializes to its own rate within `1e-6`.
- `grep` for `tokenSpeedEma` in `apps/kimi-code/src` returns zero hits — the parallel state field is gone.
- The KDoc on the sampler states the lifetime rule ("lives in the session, not the process") and names
  the three boundaries; a reader can find every reset site from that comment alone.

## T5 — Re-derive the drop priority (R6)

Change the priorities in `footer.ts`'s `buildSessionStatSegments` to the table in design.md, and replace
the ordering comment with the rule it encodes.

**Acceptance criteria**

- `footer-session-stats.test.ts:80-100` is rewritten at the same widths: `tok/s` survives at the width
  where it previously vanished, and drops only after first-token avg, LLM time, tools time, and in/out —
  each boundary asserted at its own width.
- At the narrowest asserted width, cache hit and context are still present (unchanged `Infinity` items).
- A parameterized test over the full priority table: for every item, dropping happens in the documented
  order. Fails against the previous numbering.
- The replacement comment names the rule ("live and unrecoverable-from-later-renders outranks cumulative
  totals") and lists all seven ranks.

## T6 — Reconcile the web readout (R7 — only if the user selects it)

Correct `apps/kimi-web/src/lib/sessionStats.ts` so its denominator is a measured window under the same
rule as the sampler: accumulate per-step windows for steps that reported one, alongside `decodeTokens`.

**Acceptance criteria**

- `tokensPerSecond` for a session whose steps report windows of `[800, 800]` and tokens `[100, 100]`
  returns `125`, not a value derived from any gap sum.
- A step with no measured window contributes neither tokens nor time to the ratio (the pair is skipped
  together), so a provider that reports partial data cannot bias the figure.
- With no measured window at all, `tokensPerSecond` returns `null` (unchanged contract) and the panel
  hides the item.
- The docstring names the TUI sampler and states the remaining difference as window length only.
- `bun run --filter '@moonshot-ai/kimi-web' test` passes.

If the user defers T6, the TUI-side docstring must instead state that the web figure still uses the
gap sum this repo accumulated before and is therefore not comparable — no silent divergence.
(Wording note: in this repo "upstream" means the engine layer, and git's `upstream` remote is
MoonshotAI/kimi-code. deepseek-harness is a third-party project this fork ports from, not an
upstream — see provenance.md.)

## T7 — Verify the whole path (all)

**Acceptance criteria**

- `bun run typecheck` passes repo-wide.
- `bun run test` passes for `apps/kimi-code`, with `token-speed.test.ts`,
  `footer-session-stats.test.ts`, `footer.test.ts`, `kimi-tui-message-flow.test.ts` green.
- Manual scenario, recorded in progress.md: a real streamed reply shows a `tok/s` that is stable across
  consecutive steps and within a plausible band for the model. If no real provider is reachable, say so
  and mark the check unverified — do not substitute a mocked stream for a live claim.
- progress.md records the before/after for RC1's bias with a concrete arithmetic example (a response
  whose usage frame trails the last token by 1000 ms), so the improvement is checkable on paper.
