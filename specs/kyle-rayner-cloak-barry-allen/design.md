# Design — Two rates in the footer, and what "live" can honestly mean

Requirements are in requirements.md and are not repeated here. The measured accuracy budget lives
there; this document assumes it.

## The constraint that shapes everything

A client can only measure decode from *arrivals*. This endpoint delivers ~25 tokens per batch, 310–510
ms apart. So every client-side window is quantized at both ends, and the error is
`batchInterval / window` — one-sided and high. There is no arithmetic that removes it; the only lever
is how long a window the figure is computed over.

That makes the two readouts asymmetric in difficulty:

- **average rate**: long window (the whole session). Measured +0.6% at 900 tokens. Already shipped.
- **live rate**: by definition a *short* window. This is where accuracy is hard.

## What the "live" figure can be built from

Three sources exist today; only one of them is admissible under R3.

| source | what it is | verdict |
| --- | --- | --- |
| Provider count over the step's part window | `output − 1` over first→last token-bearing part, available only at `turn.step.completed` | same source as the average (good), but **updates once per step**, so it is not live during the reply |
| Local per-delta estimate | `estimateTokensFromText` per delta, already accumulated into `appState.outputTokens` (`session-event-handler.ts:701,731`) | updates continuously, but a **different quantity**: measured 0.78–1.27 × the provider count on identical streams |
| A new mid-stream provider count | needs the engine to report cumulative `output` periodically | same source as the average **and** live — costs a protocol change |

The second row is what a naive implementation reaches for, and it is the trap: it makes the live
number continuously available and *systematically* disagree with the average, which is precisely the
"wildly off" outcome R4 forbids.

## Option A — live rate = the step's own window, shown from the provider count

The TUI already receives `llmFirstTokenOffsetMs` / `llmLastTokenOffsetMs` and `usage.output` at step
completion, and `TokenSpeedSampler` already computes exactly this per step internally before folding
it into the cumulative totals. Option A exposes that per-step figure as the live rate:

- Both figures share one token source (R3) and one window definition, so they can only differ by
  *which steps they cover*, never by *how they count*.
- Accuracy is the step-window column of the budget table: +0.6% at 900, +2.0% at 300, +7.8% at 120,
  +26.4% at 24.
- **It is not live during the reply.** The number appears when the step ends. R5 asks for an update
  during the reply; on a multi-step agent turn the figure does change per step, but within a single
  long step it sits still.

Accuracy: guaranteed by construction. Liveness: partial.

## Option B — extend the engine to report the count mid-stream

The engine already sees every part (`model-requester-impl.ts`, where `carriesOutputTokens` is
evaluated), and already accumulates a provider usage patch (`llm.streaming.usage`). Give it a periodic
emit — cumulative `output` so far plus the monotonic timestamp of that emit — and the footer can
compute a **trailing window over provider counts**:

- error ≈ `batchInterval / trailingWindow`, so a 10 s trailing window on a 310–510 ms cadence sits in
  the low single digits;
- both figures share the token source (R3) and the live one genuinely updates mid-reply (R5).

Cost: a new field on the streaming wire (`llm.streaming.usage` already exists — the question is
whether it arrives often enough on every provider, or whether a synthetic tick is needed), the
emit path through `model-requester` → `turnEvents`/loop → transcript is *not* needed if the field
rides the existing streaming event rather than the step-completion event, plus tests.

Note what option B does **not** do: the mid-stream counts still come in provider batches, so short
windows remain quantized. B buys liveness and same-source counting, not sub-batch resolution.

## Option C — average only

Keep one figure. Fails the request; recorded for completeness.

## Rejected

- **Trailing window over local estimates** — measured *worse* than the step window at every size
  (+52.1% vs +0.7% at 900 tokens) and mixes token sources (0.78–1.27 ×). Rejected on both counts; the
  measurement is in requirements.md so nobody re-tries it.
- **Widening the window to cover the missing tail** — measured earlier and rejected: overshoots by the
  margin it fixes (+28.9% → −35.5% at 24 tokens).
- **EMAs / decay constants** — the previous round removed these after measuring the per-step rate as
  unusable on a live provider; nothing here changes that.
- **Recomputing the live rate from `appState.outputTokens`** — that field is the local estimate and is
  also session-cumulative, not per-step; using it would be wrong twice.

## Display

One group, two items, joined by ` · ` inside the existing `latencySpeed` group
(`footer.ts:288-299`), so R7's "one drop slot" is satisfied by sharing `priority: 5`:

```
first token avg 1.8s · 107 tok/s now · 95 tok/s avg
```

Label wording is a design detail to fix in implementation; the requirement is only that the two are
distinguishable in both locales (R8). Where the live window is too short to meet the budget (R4), the
`now` item is omitted and the group renders `… · 95 tok/s avg` — never a placeholder number.

## Contracts

- `TokenSpeedSampler` gains a current-step reading alongside the totals: a pure
  `stepTokensPerSecond(measurement)` next to `tokensPerSecond(totals)`, and `addStep` returns both or
  the sampler exposes `current()/latest()` as a pair. Exact shape is the implementer's choice within
  the existing pure-function style; the tests in T3 pin the behaviour, not the names.
- `AppState.tokenSpeed` (currently documented as "最近一步的模型输出速度") is repurposed for the live
  figure, with a second field for the average. Its existing doc comment already claims the semantics
  the live figure needs, which is evidence the two were always intended to be separate.
- Option B adds one field to the streaming usage event; the transcript schema and kap-server protocol
  are untouched because the value is not persisted per step.

## Open decision for approval

A or B, per the option analysis above. A is accurate-but-stepwise; B is accurate-and-live at the cost
of a wire field. Both are specified far enough to start; only one should be built.
