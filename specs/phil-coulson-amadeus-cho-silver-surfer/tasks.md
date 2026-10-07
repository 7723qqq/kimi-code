# Tasks

Approach A from design.md (reject implausible samples) unless the user selects B or C. Each task names
the observable check that must fail before the change and pass after. Run the repo's own commands per
DEVELOP.md — `bun run test` and `bun run typecheck` for `apps/kimi-code` — not ad-hoc scripts.

## T1 — Give the sample a plausibility contract (R1, R2, D1)

In `apps/kimi-code/src/tui/utils/token-speed.ts`: export `MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1500` and
`isPlausibleSample(outputTokens, decodeMs): boolean`; make `computeSmoothedTokenSpeed` return `prev`
for an implausible sample, alongside its existing `outputTokens <= 0` / `decodeMs == null` / `<= 0`
checks. Update the module docstring: `serverDecodeMs` is an inter-arrival sum, not a provider
measurement (`token-speed.ts:9-10` currently claims the latter).

**Acceptance criteria**

- `isPlausibleSample(100, 30)` is `false` (3333 tok/s); `isPlausibleSample(100, 800)` is `true`
  (125 tok/s). The rate is computed by the function, not supplied — the predicate takes the same two
  arguments as the smoothing function.
- `computeSmoothedTokenSpeed(150, 100, 30)` returns exactly `150` (burst rejected, prior EMA kept).
  Fails on today's code, which returns `3333.333...`.
- `computeSmoothedTokenSpeed(null, 100, 30)` returns `null` (no prior EMA and the sample is rejected, so
  the readout stays hidden). Fails on today's code, which returns `3333.333...`.
- `computeSmoothedTokenSpeed(150, 0, 800)`, `(150, -3, 800)`, `(150, 80, null)` still return `150`; the
  `null`-vs-zero distinction is preserved.
- Boundary: a sample whose rate is exactly 1500 is accepted; 1500.1 is not. Asserted to a tolerance of
  `1e-6` so the test does not pin floating-point division noise.
- The inverted case in `apps/kimi-code/test/tui/utils/token-speed.test.ts:68-88` is rewritten: it asserts
  the burst is rejected and that the next honest sample initializes the EMA to the honest rate. The test
  must no longer assert `burst! > 3000` — that expectation documents the leak.
- `bun run --filter '@moonshot-ai/kimi-code' test` passes; `bun run typecheck` passes.

## T2 — Apply the same guard on the decode-window selection path (R1, D1)

`pickDecodeMs` currently validates only the fallback window. Make the plausibility check the selection
rule so that a positive-but-collapsed `llmServerDecodeMs` is rejected rather than accepted
(`token-speed.ts:57`).

**Acceptance criteria**

- `pickDecodeMs(30, undefined)` returns `null` (collapsed server window with no usable fallback) —
  today it returns `30`. Fails before the change.
- `pickDecodeMs(800, 50)` still returns `800` (unchanged; `token-speed.test.ts:6-8` stays green).
- `pickDecodeMs(undefined, 150)` still returns `150` and `pickDecodeMs(undefined, 120)` still returns
  `null` — `MIN_STREAM_WINDOW_MS` remains the fallback's own guard, and both boundaries are still
  exported and pinned.
- `pickDecodeMs(0, 1200)` / `(-1, 1200)` still fall back to `1200`.
- The `outputTokens` argument is threaded through: if the guard is expressed per-sample rather than per
  window, `pickDecodeMs` keeps its current two-argument signature and the token-count check stays in
  `computeSmoothedTokenSpeed` — the tasks' requirement is that *no* path admits a collapsed window, not
  which of the two functions hosts the check. Whichever placement is chosen, the four criteria above
  hold and the docstring states where the check lives.

## T3 — Give the EMA a lifetime (R3, D2)

Add `resetTokenSpeed()` to `kimi-tui.ts` (sets `this.tokenSpeedEma = null`, patches `tokenSpeed: 0`) and
call it at the three reset points named in design.md: session switch, the context-cut hook
(`noteContextCut`, `kimi-tui.ts:2675-2677`), and replay start.

**Acceptance criteria**

- After a step folds a sample, `resetTokenSpeed()` leaves `appState.tokenSpeed === 0` and the footer
  renders no `tok/s` item (the `> 0` gate at `footer.ts:498`).
- A step immediately after the reset initializes the EMA to that step's own instant rate — asserted by
  feeding a known rate and checking `appState.tokenSpeed` equals it within `1e-6`, which distinguishes
  "initialized" from "blended with a stranger's history". Fails on today's code, where the pre-reset
  value survives.
- The reset is reachable from each of the three events; each has a test that triggers the event and
  asserts the reset, not merely that the method exists.
- `noteContextCut()` and the existing cache-break reset it already performs
  (`kimi-tui.ts:2675-2677`) happen in one call — the context cut must not reset the cache baseline
  without also resetting the speed readout.
- No regression in `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`.

## T4 — Record the drop priority decision (R4, D3)

Extend the comment at `apps/kimi-code/src/tui/components/chrome/footer.ts:231-232` with the reason `tok/s`
ranks below the session totals (recoverable vs cumulative, per design.md R4). No priority value changes.

**Acceptance criteria**

- `footer.ts:282-284` still reads `priority: 3`; `footer-session-stats.test.ts:80-100` passes unchanged.
- The comment names all six ranks in the order they are dropped and states the recoverability reason in
  one sentence. A reviewer reading only the comment can predict which item `fitSessionStatsText` drops
  first.

## T5 — Cross-reference the two implementations (R5, D4)

Add a docstring line to `apps/kimi-code/src/tui/utils/token-speed.ts` and to
`apps/kimi-web/src/lib/sessionStats.ts:217-220`, each naming the other file and the difference
(TUI = step-level EMA of instantaneous rates; Web = session-cumulative ratio) in one sentence. No
behavior change in either file.

**Acceptance criteria**

- Each file's docstring names the other file by path and states the difference; grep for
  `sessionStats.ts` in `token-speed.ts` and for `token-speed.ts` in `sessionStats.ts` returns one hit
  each.
- `bun run test` for both packages passes with no behavioral test changed by this task (the diff of
  T5's commit is comments only).

## T6 — Verify the whole path (all)

**Acceptance criteria**

- `bun run typecheck` passes repo-wide.
- `bun run test` passes for `apps/kimi-code`, with `token-speed.test.ts`,
  `footer-session-stats.test.ts`, `footer.test.ts` and `kimi-tui-message-flow.test.ts` all green.
- Manual scenario, recorded in progress.md: a streamed reply with a real provider shows a stable
  `tok/s` in the footer, and the value does not jump by an order of magnitude between consecutive steps.
  If no such provider is reachable in the environment, say so explicitly and mark the check unverified
  rather than substituting a mocked stream.
