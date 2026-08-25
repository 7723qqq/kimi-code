/**
 * Tokens-per-second accounting for the footer's "tok/s" readout.
 *
 * Three problems used to corrupt this number:
 *   1. The denominator was `llmStreamDurationMs`, the wall-clock between the
 *      first and last SSE event. Providers that batch the response into a
 *      handful of events (cached responses, fast streams, batched proxies)
 *      collapse this window to a few ms, producing absurdly high rates
 *      (thousands of tok/s). `llmServerDecodeMs` — the provider-reported
 *      time it actually spent generating — is the right denominator when
 *      available. Providers without decode accounting (Kimi/OpenAI-
 *      compatible endpoints) fall back to the wall-clock window, which is
 *      only trusted when it has not collapsed (`MIN_STREAM_WINDOW_MS`): a
 *      sub-threshold window means the whole reply arrived in one burst, so
 *      the sample is discarded and the previous EMA stands.
 *   2. The raw per-step rate is noisy on short outputs (a 5-token reply
 *      finishing in 80 ms reads as 60 tok/s even when steady-state is 150).
 *      Apply an EMA so the readout reflects recent history without erasing
 *      step-by-step responsiveness.
 *
 * ## EMA tuning
 *
 *   α = 0.4 weights the latest step at 40% and the prior EMA at 60%.
 *   - The first non-null sample initializes the EMA (no smoothing across an
 *     undefined baseline).
 *   - Steps that produce no usable measurement (`outputTokens` ≤ 0 or
 *     `decodeMs` ≤ 0) keep the prior EMA unchanged, so a pure tool-call
 *     step never resets the readout to zero between text replies.
 *
 * Returns `null` when no usable sample exists yet (no output, no decode
 * time, or both decode fields missing), so callers can distinguish "have
 * not measured yet" from "actually zero".
 */

const EMA_ALPHA = 0.4;

/** Wall-clock stream windows shorter than this are treated as collapsed
 *  (cached / batched responses delivering every event in one burst) and
 *  rejected on the fallback path — dividing by them reads as thousands of
 *  tok/s. Real token-by-token streams rarely complete faster than this even
 *  for one-word replies, and skipping such samples merely keeps the prior
 *  EMA. */
export const MIN_STREAM_WINDOW_MS = 150;

/** Pick the decode-window denominator for the throughput calculation.
 *
 * Prefers `llmServerDecodeMs` (the provider's own measurement of time spent
 * generating) and only falls back to `llmStreamDurationMs` (wall-clock
 * between first and last SSE event) when the provider omitted the decode
 * split AND that window did not collapse. Returns `null` when nothing
 * usable remains.
 */
export function pickDecodeMs(
  llmServerDecodeMs: number | undefined,
  llmStreamDurationMs: number | undefined,
): number | null {
  if (typeof llmServerDecodeMs === 'number' && llmServerDecodeMs > 0) return llmServerDecodeMs;
  if (
    typeof llmStreamDurationMs === 'number' &&
    llmStreamDurationMs >= MIN_STREAM_WINDOW_MS
  ) {
    return llmStreamDurationMs;
  }
  return null;
}

/** Fold one step's output/decode sample into the EMA. Returns the new EMA,
 *  or `prev` unchanged when the sample is unusable (so a tool-only step
 *  does not drag the readout back to zero).
 */
export function computeSmoothedTokenSpeed(
  prev: number | null,
  outputTokens: number,
  decodeMs: number | null,
): number | null {
  if (outputTokens <= 0 || decodeMs === null || decodeMs <= 0) return prev;
  const instant = (outputTokens / decodeMs) * 1000;
  if (prev === null) return instant;
  return EMA_ALPHA * instant + (1 - EMA_ALPHA) * prev;
}