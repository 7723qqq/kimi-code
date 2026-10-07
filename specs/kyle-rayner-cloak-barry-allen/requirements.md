# Requirements — A live rate beside the session average in the footer

## Goal

The footer's second line shows one decode rate. Make it show two, side by side:

- **live rate** — how fast the reply being generated right now is producing tokens;
- **average rate** — the session-cumulative rate already shown today.

Both must be *accurate*: neither may display a figure that is wildly off the rate the stream actually
achieved. The user's words: "两个都要显示 … 要求是准确，不能出现非常离谱的偏差" (both must be shown;
it must be accurate; no wildly wrong deviation).

"Wildly wrong" is not left to judgement — see the accuracy budget below, which is measured, not
asserted.

## Audience

- **Users watching a reply stream**: the live rate answers "is this going fast or slow right now",
  the average answers "how has this session been going". They are different questions and the footer
  must not conflate them.
- **Maintainers** of `apps/kimi-code/src/tui/utils/token-speed.ts` and the footer stats row: the
  accuracy contract for each figure must be written where they will look.

## The accuracy budget (measured, not assumed)

Taken against MiniMax-M2 with `specs/argent-bobbi-morse-she-hulk/measure-minimax.mjs`; the reference
is the provider's own `output_tokens` over the streamed span.

| reply size | step-window error | note |
| --- | --- | --- |
| 900 tokens | +0.6% | |
| 500 tokens | +1.4% | |
| 300 tokens | +2.0% | |
| 120 tokens | +7.8% | |
| 24 tokens | +26.4% | window is ~300 ms; quantization dominates |

The error is one-sided and has a closed form: the window's two ends are each quantized by the
endpoint's batch interval (~25 tokens and 310–510 ms on this endpoint), and both lost slices are
decode, so the rate reads high by about `batchInterval / window`.

**A trailing sliding window does not fix this — it makes it worse.** Measured over the same runs:
900 tokens went from +0.7% (step window) to **+52.1%** (last 3 s), 300 tokens from +2.0% to +35.6%.
The deltas are too few for a short window to hold a sample.

**Local token estimation is not interchangeable with the provider's count.** The TUI already
estimates tokens per delta (`estimateTokensFromText`, ASCII ÷ 4 + non-ASCII); measured against the
provider's own count on identical streams the ratio ran **0.78 – 1.27**. Mixing the estimate into one
figure and the provider count into the other would separate the two readouts by up to 27%, varying
with content.

## Requirements

- **R1** The footer shows two rates, each labelled so a user can tell them apart without reading the
  code. Both appear together whenever both are available.
- **R2** The average rate keeps today's contract: session-cumulative, `output − 1` over the summed
  token-bearing-part windows, `null` until a step contributes, reset on session switch / `/undo` /
  replay.
- **R3** The live rate describes the reply in flight and is derived from the same provider-reported
  token count as the average, so the two cannot disagree for a reason the user cannot see. A rate
  built from locally estimated tokens, or from a window too short to hold a sample, is out of scope by
  construction — both are measured above as worse.
- **R4** Neither figure may display a value whose error against the stream's own rate exceeds the
  budget in the table for its window length. Where the window is too short to meet that budget, the
  live rate shows a placeholder/omits itself rather than a number. A wrong number is worse than no
  number; the module already takes this position for a single-token step.
- **R5** The live rate updates while the reply streams, not only when the step ends — a "live" figure
  that appears only after the step completes fails its own purpose. The update cadence is a design
  decision; the observable requirement is that the figure changes at least once during a reply long
  enough to contain a measurable sample.
- **R6** Both figures are scrubbed by the same reset rules as the average today (R2), so a new session
  cannot inherit the previous session's live reading.
- **R7** The narrow-terminal behaviour stays coherent: the two rates occupy one drop-priority slot, so
  they are dropped together or kept together, and the existing ranking rationale (live information
  last to go) is not silently inverted.
- **R8** Both locales render the new labels; no locale key may render as a raw key name (the repo has
  a CI check for this).

## Boundaries

- **In scope**: the TUI footer readout, its sampler, its tests, and its locale entries.
- **Out of scope**: the web status panel's single rate (it keeps the cumulative figure), the
  `debug-timing.ts` debug line (a third, unrelated formula — its fate is a separate decision already
  deferred), and any change to how the engine processes parts other than what T3 needs.
- **Out of scope unless the user picks option B**: protocol changes to carry periodic token counts
  mid-stream. Options are presented for approval.

## Open decisions carried into design

1. Which window the live rate uses, given R3/R4 rule out the naive sliding window (options A/B/C).
2. Whether the live rate may borrow the engine's already-stamped endpoints or needs a new mid-stream
   signal.
