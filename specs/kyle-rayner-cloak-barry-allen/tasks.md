# Tasks — Two rates in the footer

Tasks are ordered so each one is independently checkable. Task numbers are stable references, not a
strict sequence: T1 is a prerequisite for T3/T4, T5 depends on T3+T4, and T6/T7 are the two build
options of which exactly one is executed.

The accuracy budget and the rejected approaches live in requirements.md and design.md; this file does
not restate them.

---

## T1 — Split the sampler's two outputs (no behaviour change yet)

`apps/kimi-code/src/tui/utils/token-speed.ts`: expose the current step's rate next to the cumulative
one. `measureStep` already produces the per-step measurement; add a pure
`stepTokensPerSecond(measurement): number | null` beside `tokensPerSecond(totals)`, and have
`TokenSpeedSampler.addStep` surface both (return shape is the implementer's choice; keep the
pure-function style and the existing `null`-not-zero discipline).

**Acceptance criteria**

- `stepTokensPerSecond(measureStep(0, 800, 100))` is `123.75` (99 gaps over 800 ms) — the same
  arithmetic the cumulative total is built from, asserted independently.
- A step that `measureStep` rejects (one token, missing endpoint, non-positive window) yields `null`
  from the new function, not `0` and not `NaN`.
- `TokenSpeedSampler.addStep` after a rejected step returns the previous live value unchanged, matching
  how the totals already hold.
- `reset()` clears the live value as well as the totals: after `addStep(0, 800, 100)` then `reset()`,
  the live value is `null`.
- `bunx vitest run --root apps/kimi-code test/tui/utils/token-speed.test.ts` passes, and the existing
  13 tests in that file are unchanged in intent.

---

## T2 — Carry both figures through AppState

`apps/kimi-code/src/tui/types.ts` and `apps/kimi-code/src/tui/kimi-tui.ts`: add the average field
beside the existing `tokenSpeed`, and correct the doc comments so each says which quantity it holds
(`tokenSpeed`'s current comment, "最近一步的模型输出速度", describes the live figure; the average
needs its own).

**Acceptance criteria**

- `AppState` declares two rate fields with distinct doc comments; neither comment claims the other's
  semantics.
- `noteStepCacheStats` patches both when a step contributes, and leaves both untouched when it does
  not.
- `resetTokenSpeed()` clears both, and the existing three call sites (session switch, `/undo`, replay)
  need no change — asserted by the existing reset tests still passing.
- `bunx tsc -p apps/kimi-code/tsconfig.json --noEmit` is clean.

---

## T3 — Render both, one drop slot

`apps/kimi-code/src/tui/components/chrome/footer.ts` (`buildSessionStatSegments`, `:288-299`) and the
locale files: emit the live item and the average item joined by ` · ` inside the existing
`latencySpeed` group, both at `priority: 5`.

**Acceptance criteria**

- With both figures available, line 2 contains both labels, e.g. `107 tok/s now · 95 tok/s avg`.
- With only the average available, line 2 contains the average label and **no** live label, and no
  placeholder glyph or `0`.
- With only the live available (first step of a fresh session), line 2 contains the live label and no
  average label.
- **Narrow-terminal check**: at the width where `fitSessionStatsText` currently drops the rate, both
  labels are absent together — never one without the other. Asserted at the same widths the existing
  `footer-session-stats.test.ts` narrowing test already pins.
- `bun run check:locale-keys` and `bun run check:t-coverage` pass; neither `en` nor `zh` renders a raw
  key name.

---

## T4 — Reset and partial-step behaviour

Extend `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`, which already owns the speed cases.

**Acceptance criteria**

- A step that reports a window but no usable token count leaves the live figure at its previous value
  and does not change the average.
- After `resetTokenSpeed()`, both figures are absent from the rendered footer, and the next step's
  live figure equals that step's own rate within `1e-6` (not blended with anything inherited).
- A step whose window is shorter than the budget can support (the collapsed-window case already in the
  file) leaves the live figure unchanged rather than showing a burst.

---

## T5 — Prove the accuracy claim on a live provider

Reuse `specs/argent-bobbi-morse-she-hulk/measure-minimax.mjs` and
`specs/kyle-rayner-cloak-barry-allen/probe-two-rates.mjs` (to be written) to check the shipped
readouts against the provider's own count.

**Acceptance criteria**

- For replies of ~900, ~300, ~120 and ~24 tokens, the measured median error of the **average** figure
  is within the budget column in requirements.md (±0.9%, ±2.5%, ±10%, ±35% respectively).
- The **live** figure's median error on the same runs is no worse than the step-window column — this is
  the regression guard against someone re-introducing a sliding window over local estimates.
- A run that produces fewer than two measurable steps leaves the live figure at `n/a` in the report,
  recorded as such rather than filled with a guess.
- The measurement is recorded in this spec's `progress.md` with the sample count, so the figure is
  reproducible rather than asserted.

---

## T6 — Option A: the live figure is the step's own window

Wire the per-step rate from T1 through T2 to the footer. No engine change.

**Acceptance criteria**

- During a multi-step turn, the live figure changes between steps and the average moves toward it —
  asserted in `kimi-tui-message-flow.test.ts` by feeding two steps with known rates.
- Within a single step, the live figure is the previous step's value until the step completes; this is
  documented in the module docstring as a known limitation, not left implicit.
- `bun run --filter '@moonshot-ai/kimi-code' test` passes.

---

## T7 — Option B: the engine reports the count mid-stream

Add a periodic cumulative-output field to the streaming usage event in
`packages/agent-core-v2/src/llm-adapter/model/model-requester-impl.ts` (the `llm.streaming.usage`
path) and consume it in the TUI to compute a trailing window over **provider** counts. Requires T6's
plumbing as the averaging half.

**Acceptance criteria**

- The live figure changes at least twice within a single step that streams for more than 5 seconds —
  asserted by a controller test driving synthetic usage ticks with known timestamps.
- The trailing window's error against the provider count stays within the budget for a 10 s window
  (measured in T5, recorded in `progress.md`).
- No field is added to the step-completion event or the transcript schema — the value is not persisted
  per step, and `packages/transcript/src/contract/schema.ts` is unchanged.
- A provider that never emits the periodic count falls back to T6's stepwise behaviour without
  displaying a wrong number — asserted by a test that withholds the ticks.
- `bun run --filter '@moonshot-ai/kimi-code' test` and the agent-core-v2 suite pass.

---

## T8 — Documentation and changelog

**Acceptance criteria**

- The `token-speed.ts` module docstring states both figures' contracts and points at the measured
  budget rather than repeating a claim.
- A `.changeset/*.md` entry for `@moonshot-ai/kimi-code` describes the user-visible change (per
  `.changeset/README.md`), with no author identity in the message.
- `apps/kimi-code/src/tui/components/chrome/footer.ts`'s drop-priority comment still predicts the
  order accurately, now that the group holds two items.

---

## Verification (all)

- `bun run typecheck` passes repo-wide.
- `bun run --filter '@moonshot-ai/kimi-code' test` passes, with `token-speed.test.ts`,
  `footer-session-stats.test.ts` and `kimi-tui-message-flow.test.ts` green.
- T5's measurement is recorded in `progress.md`, including any figure that could not be verified.
