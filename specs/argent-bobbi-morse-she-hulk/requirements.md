# Requirements — Rebuilding the tok/s readout on a denominator that means something

## Goal

The footer's `tok/s` readout is not suffering from a bug; it is built on a quantity that measures
something else. Every patch applied so far — and the previous round's 1500 tok/s plausibility ceiling is
exactly such a patch — has been trying to make a wrong measurement behave, without replacing it.

This round replaces the measurement. The deliverable is a `tok/s` figure whose numerator and denominator
describe the *same* interval of the *same* stream, produced by the component that actually observes that
stream, and a footer that shows it without pretending to more confidence than the data supports. The
upstream timing fields that are being misread are left in place for their legitimate consumer; only the
readout's source changes.

## Root causes

Investigated fresh, with citations. The previous round's defect list (D1–D4) is restated below in terms of
the causes found this time; where the earlier diagnosis was too shallow, that is said explicitly.

### RC1 — the denominator and the numerator do not cover the same interval (the real root cause)

`packages/kosong/src/generate.ts:140-209` accumulates two buckets over the stream:

```
firstPartAt = <time the first part arrived>          // :147-148, NOT added to serverDecodeMs
for each later part:  serverDecodeMs += arrivedAt - lastResumeAt   // :150
                      clientConsumeMs += now - arrivedAt           // :198
after the loop:       serverDecodeMs += Date.now() - lastResumeAt  // :205  (the "tail wait")
```

So `serverDecodeMs` is **the whole observed span minus the first part's arrival** — the first-frame wait
is excluded, and the tail (the usage frame, the stream's closing handshake) is included. Republished
upstream as `ModelRequestTiming.serverDecodeMs`
(`packages/agent-core-v2/src/llm-adapter/model/model-requester-impl.ts:228-271`, `:413-419`) and consumed
by the TUI as the readout's denominator.

`usage.output`, meanwhile, counts exactly the tokens the model decoded. The two do not describe the same
interval: the denominator includes the trailing idle wait after the last token, and excludes the wait for
the first one. Every rate computed from them is biased low by the tail share, and there is no constant
that can correct it because the tail share varies per provider.

### RC2 — the field is named, documented, and consumed as something it is not

`packages/kosong/src/provider.ts:226-242` describes `StreamDecodeStats.serverDecodeMs` accurately as
"cumulative time spent awaiting the next streamed part (server + network)", and explicitly notes that a
GC pause landing in the wait is counted in it. Its stated purpose (`:232-235`) is to tell whether the
*client* is throttling decode, via the `clientConsumeMs` share — a diagnostic, not a rate input.

`model-requester.ts:23-31` keeps `streamDurationMs` mandatory and `serverDecodeMs` optional, so a provider
that never streams parts (`firstPartAt === undefined`, `generate.ts:208` passes `undefined`) leaves the
TUI with only `streamDurationMs` — literally the first-to-last-event span, which is the same
"observed span minus head" shape with an even larger error. The previous round's docstring still called
this pair "the provider-reported time it actually spent generating"; nothing in the chain reports that.

### RC3 — the guard was placed where the bias is not, and expressed in the wrong unit

The previous round added `MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1500` and made both selection paths check it.
That catches the collapsed-burst case, which is a real but *secondary* failure (a batched proxy delivering
every event in one tick). It does nothing for RC1, which is the everyday error on every provider, and it
adds a magic constant to a module that already carried `MIN_STREAM_WINDOW_MS`. Two thresholds for one
quantity, neither derived from the data, is the tell that the denominator is wrong.

### RC4 — the EMA has no lifetime

`tokenSpeedEma` (`kimi-tui.ts:317`) is written only inside the sample fold. The previous round wired
resets at three session boundaries, which is a genuine improvement but still leaves the smoothing state
and its reset rule duplicated between `token-speed.ts` (the constant) and `kimi-tui.ts` (the resets).

### RC5 — the blend mixes rates from steps of different sizes and different windows

`computeSmoothedTokenSpeed` blends each step's instantaneous rate with α = 0.4 regardless of how much
evidence that step carries. A 5-token step and a 500-token step move the readout equally. That is the
reason short replies visibly jitter, and why the previous round needed a burst clamp at all: burst
samples are weighted like honest ones.

### RC6 — the drop priority ranks a measurement below decorations

`tok/s` carries `priority: 3` (`footer.ts:283`) and is dropped before LLM time (4), input/output (5) and
turn/step counts (6). The previous round kept the ranking and documented it. Documenting a ranking is not
fixing it: the user watching a stream on a narrow pane loses the live number first while static totals
survive.

### RC7 — two products, one label, two definitions

`apps/kimi-web/src/lib/sessionStats.ts:218-220` (session-cumulative ratio, one decimal below 10) and the
TUI (step-level EMA, one decimal below 100) both render `tok/s`. The previous round added cross-referencing
docstrings. That makes the divergence legible; it does not make the numbers reconcilable, and the web
side carries its own instance of RC1: its `decodeMs` accumulates the same `serverDecodeMs`.

## Requirements

- **R1 (RC1)** The readout's denominator must be measured over an interval that contains the same tokens
  the numerator counts, by a component that observes the stream. It must not be derived from
  `serverDecodeMs`, `streamDurationMs`, or any other field whose definition is "gaps between events".
- **R2 (RC1, RC2)** Head and tail must be excluded symmetrically: the interval starts when the count
  starts accumulating and ends when it stops. A stream whose events all arrive before the first token is
  emitted must not report a rate at all rather than a fabricated one.
- **R3 (RC3)** The plausibility guard must be derived from the measurement it guards, not from a
  hand-picked ceiling; where a ceiling remains necessary it must be justified in the design and
  documented as a bound on the *model*, not on the transport.
- **R4 (RC4)** The smoothing state and its lifetime must live in one place with one owner, and the resets
  must be a property of that owner rather than three call sites wired by hand.
- **R5 (RC5)** Smoothing must weight steps by the evidence they carry, so a 5-token step cannot move the
  readout as far as a 500-token one.
- **R6 (RC6)** The drop priority must be re-derived rather than inherited, and the result must be
  justified against the other items by what a user loses when each is dropped.
- **R7 (RC7)** The web readout's denominator must be corrected to the same standard as the TUI's, so the
  two numbers differ (if at all) only by window length — a difference a user can reason about — and not
  by covering different intervals.
- **R8** Nothing outside the readout may regress: `serverDecodeMs`/`clientConsumeMs` keep their diagnostic
  consumer, first-token latency and session LLM time keep their existing definitions, and the pinned
  footer rendering tests keep passing.

## Boundaries

**In scope**
- `apps/kimi-code/src/tui/utils/token-speed.ts` — may be replaced wholesale.
- `kimi-tui.ts:2591-2635` (`noteStepCacheStats`, `resetTokenSpeed`) and whatever state ownership R4
  implies.
- `apps/kimi-code/src/tui/components/chrome/footer.ts`'s stats row and priorities, and
  `session-stats.ts`'s formatting/fitting helpers where R6 touches them.
- `apps/kimi-web/src/lib/sessionStats.ts` where R7 applies.
- The session-event path that carries the readout's new input (`session-event-handler.ts:549` region).

**Out of scope (deliberately, and unlike the previous round)**
- Changing `StreamDecodeStats`, `generate.ts`'s accounting, or `model-requester`'s timing fields. They are
  correct for their diagnostic purpose (RC2); the fix is to stop consuming them as a rate input, not to
  redefine them. This keeps the change off the provider hot path.
- Adding a provider-facing "decode time" field. No provider in the tree reports one, so it would be an
  API surface with no producer.
- The `/status` panel, the human timing plugin, and the transcript's debug timing.

## Open decisions for the user

Two choices materially change the design and are passed to ExitSpecMode:

1. **What the number means.** A live rate for the reply in flight, or a session figure that is stable but
   lags. These lead to different modules, not different constants.
2. **Whether the web readout is corrected in this round** (R7) or explicitly deferred. It is a second
   product's file; correcting it is small but touches a surface this round otherwise leaves alone.
