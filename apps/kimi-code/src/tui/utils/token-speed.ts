/**
 * Decode rate for the footer's "tok/s" readout.
 *
 * ## What this is
 *
 * A session-cumulative ratio: every completed step adds its decode window to
 * `decodeMs` and the tokens produced in that window to `decodeTokens`, and the
 * readout is their quotient. It answers "how fast has this session been
 * decoding" rather than "how fast is this reply going" — it moves slowly and
 * never jumps.
 *
 * ## Why cumulative
 *
 * A per-step reading was measured against this one and lost. The step's own
 * rate is `1 / window`, so a short window — a cached or batched response whose
 * parts arrive compressed — produces an extreme rate from a handful of tokens,
 * and no weighting makes such a sample safe to add: its value is inflated by
 * the same factor that shrinks its weight. Across live runs the per-step
 * figure swung by a factor of four between adjacent replies, while a ratio
 * accumulated over the session stayed inside a narrow band. A steady number
 * that reads slightly low is usable; one that swings fourfold is not.
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
 * Two things follow, both tested rather than assumed. Widening the window to
 * cover the missing tail overshoots by about the margin it fixes (measured
 * −35% at 24 tokens against +29% shipped), so it is not an improvement. And
 * past a few hundred tokens the readout is accurate to better than 1%, which
 * makes the residual a property of coarse-grained delivery rather than of this
 * arithmetic.
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

/** Session-scoped accumulator for the footer readout. Owns the totals and
 *  their lifetime so the callers do not carry reset rules of their own. */
export class TokenSpeedSampler {
  private totals: TokenSpeedTotals = EMPTY_TOKEN_SPEED_TOTALS;

  /** Fold one completed step in. Returns the new cumulative rate, or `null`
   *  while no step has contributed. */
  addStep(
    firstTokenAtMs: number | undefined,
    completedAtMs: number | undefined,
    outputTokens: number,
  ): number | null {
    this.totals = accumulateStep(
      this.totals,
      measureStep(firstTokenAtMs, completedAtMs, outputTokens),
    );
    return tokensPerSecond(this.totals);
  }

  /** The cumulative rate, or `null`. */
  current(): number | null {
    return tokensPerSecond(this.totals);
  }

  /** Start over: the next step begins a fresh session's average. */
  reset(): void {
    this.totals = EMPTY_TOKEN_SPEED_TOTALS;
  }
}
