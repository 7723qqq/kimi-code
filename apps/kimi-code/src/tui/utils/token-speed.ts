/**
 * The footer's two decode rates.
 *
 * ## What they are
 *
 * Two figures, from one measurement:
 *
 *   - `step` — the rate of the step that just closed, "how fast did that reply
 *     go";
 *   - `average` — the session so far, "how fast has this session been going".
 *
 * Both divide a decode window into the tokens produced in it, using the same
 * provider-reported count and the same window definition. They can therefore
 * differ only in *which steps they cover*, never in how they count — which is
 * what lets them sit next to each other without contradicting one another.
 *
 * ## Why the average is cumulative
 *
 * A per-step reading alone was measured against a cumulative one and lost. The
 * step's own rate is `1 / window`, so a short window — a cached or batched
 * response whose parts arrive compressed — produces an extreme rate from a
 * handful of tokens, and no weighting makes such a sample safe to add: its
 * value is inflated by the same factor that shrinks its weight. Across live
 * runs the per-step figure swung by a factor of four between adjacent replies,
 * while a ratio accumulated over the session stayed inside a narrow band.
 *
 * That finding is why the *average* exists, and it is also why the *step*
 * figure is gated rather than shown unconditionally: a single short step has
 * nothing to average against.
 *
 * ## What the window is
 *
 * The decode window per step is `firstToken → lastToken`: from the first
 * streamed part carrying generated tokens to the last one, both sampled by the
 * engine (`llmFirstTokenOffsetMs` / `llmLastTokenOffsetMs`). The endpoints are
 * chosen so the interval brackets the tokens rather than being corrected for
 * them afterwards:
 *
 *   - The head wait before the first token is latency, not decode, and falls
 *     outside the window by construction.
 *   - The tail — the usage frame, the finish frame, the stream close — produced
 *     no tokens, and including it would depress every reading. It also falls
 *     outside.
 *
 * `n` tokens are separated by `n - 1` inter-token gaps, so the interval the
 * endpoints bracket holds `n - 1` tokens. Counting the token the window starts
 * on as well — `n` over an `n - 1` interval — would read every step slightly
 * high, by `1/(n-1)`: a rate that looks precise but is not the one the stream
 * achieved.
 *
 * The convention is chosen to agree with the other two figures in the product
 * rather than with each in isolation: the web status panel divides the same
 * interval, and `formatTokenSpeed`/`formatTokensPerSecond` render the same
 * unit. A step reporting a single token contributes nothing at all, since the
 * interval it would need does not exist.
 *
 * ## How accurate the window is, measured
 *
 * Against MiniMax-M2 — an endpoint that batches roughly 25 tokens per streamed
 * part, so part arrivals are 310–510 ms apart — comparing the readout with the
 * provider's own token count over the whole streamed span:
 *
 * | reply size | median error |
 * | --- | --- |
 * | 900 tokens | +0.6% |
 * | 500 tokens | +1.4% |
 * | 300 tokens | +2.0% |
 * | 120 tokens | +8.1% |
 * | 60 tokens | +9.0% |
 * | 24 tokens | +29% |
 *
 * The error is one-sided and has a closed form: the window's two ends are each
 * quantized by the batch interval, and both lost slices are decode, so the rate
 * reads high by about `batchInterval / window`. That is 3% at 900 tokens and
 * 50–100% at 24, which is what the table shows.
 *
 * Three things follow, all tested rather than assumed. Widening the window to
 * cover the missing tail overshoots by about the margin it fixes (measured
 * −35% at 24 tokens against +29% shipped), so it is not an improvement. A
 * trailing window over locally estimated tokens is worse still — +52% at 900
 * tokens against +7% for the step window, because a short window holds too few
 * samples and the estimate is a different quantity from the provider's count
 * (0.78–1.27× it on identical streams). And past a few hundred tokens the
 * readout is accurate to better than 1%, which makes the residual a property of
 * coarse-grained delivery rather than of this arithmetic.
 *
 * The short end is where the figure stops being defensible, so it is where
 * `MIN_STEP_WINDOW_MS` applies: a ~300 ms window (a 24-token reply) measured
 * 33–37% high across ten live runs, while a 500 ms window (~120 tokens) stayed
 * under 9%. The footer shows the step rate only above that floor and holds the
 * previous reading below it; the average is never gated, because it accumulates
 * the same windows and so converges as the session grows.
 *
 * ## Lifetime
 *
 * Cumulative within a session, not across sessions: `reset()` is called when
 * the session switches, when `/undo` cuts the context, and when a replayed
 * session hydrates.
 */

/** Steps below this token count contribute no sample. A single token has no
 *  interval, and a handful of tokens says nothing about throughput; the
 *  serving specs treat a one-token step as undefined for the same reason. */
const MIN_SAMPLE_TOKENS = 2;

/** The shortest window that may be shown as a *step* rate, ms.
 *
 *  Measured on an endpoint that batches ~25 tokens per streamed part 310-510 ms
 *  apart: a step's window is quantized at both ends by that interval, so the
 *  rate reads high by roughly `batchInterval / window`. Over ten live runs the
 *  error was 33-37% at a ~300 ms window (24 tokens) and under 9% from ~500 ms
 *  up. A 24-token reply therefore sits on the edge of what any client-side
 *  window can resolve, and the footer does not show a figure it cannot stand
 *  behind: below this the step rate holds its previous value, exactly as it
 *  does for a step that reported no tokens at all.
 *
 *  The session average is deliberately not gated by this — it accumulates the
 *  same windows, so its error shrinks as the session grows rather than
 *  depending on the single step just closed.
 */
const MIN_STEP_WINDOW_MS = 500;

export interface TokenSpeedTotals {
  /** Summed decode window across sampled steps, ms. */
  readonly decodeMs: number;
  /** Summed output tokens across the same steps. */
  readonly decodeTokens: number;
}

export const EMPTY_TOKEN_SPEED_TOTALS: TokenSpeedTotals = { decodeMs: 0, decodeTokens: 0 };

/** One step's contribution: its decode window and the tokens produced in it. */
export interface StepMeasurement {
  /** Tokens the provider reported for the step. */
  readonly outputTokens: number;
  /** Tokens the window spans: `outputTokens - 1` gaps — the same convention
   *  the web status panel and the serving specs use. */
  readonly windowTokens: number;
  readonly windowMs: number;
}

/** Brackets one step's decode window. Pure, so the arithmetic is testable
 *  without a stream. Returns `null` when the step carries no rate of its own:
 *  no endpoints, no tokens, a single token, or a non-positive window. */
export function measureStep(
  firstTokenAtMs: number | undefined,
  completedAtMs: number | undefined,
  outputTokens: number,
): StepMeasurement | null {
  if (firstTokenAtMs === undefined || completedAtMs === undefined) return null;
  if (!Number.isFinite(outputTokens) || outputTokens < MIN_SAMPLE_TOKENS) return null;
  const windowMs = completedAtMs - firstTokenAtMs;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
  return { outputTokens, windowTokens: outputTokens - 1, windowMs };
}

/** Fold one step's measurement into the running totals. A step with no
 *  measurable window is skipped **as a pair** — counting its tokens without its
 *  time (or the reverse) would bias the ratio. */
export function accumulateStep(
  totals: TokenSpeedTotals,
  measurement: StepMeasurement | null,
): TokenSpeedTotals {
  if (measurement === null) return totals;
  return {
    decodeMs: totals.decodeMs + measurement.windowMs,
    decodeTokens: totals.decodeTokens + measurement.windowTokens,
  };
}

/** The cumulative rate, or `null` before anything measurable has completed. */
export function tokensPerSecond(totals: TokenSpeedTotals): number | null {
  if (totals.decodeMs <= 0 || totals.decodeTokens <= 0) return null;
  return (totals.decodeTokens / totals.decodeMs) * 1000;
}

/** One step's own rate, or `null` when the step measured nothing **or** when
 *  its window is too short for the figure to be trustworthy (see
 *  `MIN_STEP_WINDOW_MS`). Built from the same measurement the totals are built
 *  from, so the two figures can differ only in which steps they cover — never
 *  in how they count. */
export function stepTokensPerSecond(measurement: StepMeasurement | null): number | null {
  if (measurement === null || measurement.windowMs <= 0) return null;
  if (measurement.windowMs < MIN_STEP_WINDOW_MS) return null;
  return (measurement.windowTokens / measurement.windowMs) * 1000;
}

/** The two figures the footer shows side by side: the step just closed, and
 *  the session so far. Either may be `null` while nothing measurable has been
 *  seen; neither is ever zero-as-a-stand-in-for-unknown. */
export interface TokenSpeedReadout {
  readonly step: number | null;
  readonly average: number | null;
}

/** Session-scoped accumulator for the footer readout. Owns the totals, the
 *  latest step's reading, and their lifetime so the callers do not carry reset
 *  rules of their own. */
export class TokenSpeedSampler {
  private totals: TokenSpeedTotals = EMPTY_TOKEN_SPEED_TOTALS;
  private lastStep: number | null = null;

  /** Fold one completed step in. Both figures are returned: the step's own rate
   *  and the session's. A step with no measurable window leaves the step figure
   *  standing rather than clearing it — the reply it described is still the
   *  most recent one — while the average simply does not move. */
  addStep(
    firstTokenAtMs: number | undefined,
    completedAtMs: number | undefined,
    outputTokens: number,
  ): TokenSpeedReadout {
    const measurement = measureStep(firstTokenAtMs, completedAtMs, outputTokens);
    this.totals = accumulateStep(this.totals, measurement);
    const step = stepTokensPerSecond(measurement);
    if (step !== null) this.lastStep = step;
    return { step: this.lastStep, average: tokensPerSecond(this.totals) };
  }

  /** Both figures, or `null` for whichever has no reading yet. */
  current(): TokenSpeedReadout {
    return { step: this.lastStep, average: tokensPerSecond(this.totals) };
  }

  /** Start over: the next step begins a fresh session's average, and the
   *  previous session's step reading must not outlive it. */
  reset(): void {
    this.totals = EMPTY_TOKEN_SPEED_TOTALS;
    this.lastStep = null;
  }
}
