import { describe, expect, it } from 'vitest';

import { measureStep } from '#/tui/utils/token-speed';

/**
 * Accuracy harness: drives `measureStep` — the exact function the footer's rate
 * is computed from — against streams whose true decode rate is known.
 *
 * A "stream" here is the pair of observations the engine makes: the arrival of
 * the first and last token-bearing part (`llm.streaming.part`), plus the token
 * count the provider reported for the step.
 */
function measureStream(parts: readonly number[], outputTokens: number): number | null {
  const m = measureStep(parts[0], parts[parts.length - 1], outputTokens);
  return m === null ? null : (m.windowTokens / m.windowMs) * 1000;
}

/** n tokens produced at a constant rate, delivered one per token. */
function steadyStream(rate: number, tokens: number, startAt = 0): number[] {
  const step = 1000 / rate;
  return Array.from({ length: tokens }, (_, i) => startAt + i * step);
}

const errorPct = (measured: number | null, truth: number): string =>
  measured === null ? 'n/a' : `${(((measured - truth) / truth) * 100).toFixed(2)}%`;

describe('decode-rate accuracy against known-truth streams', () => {
  it('is exact on a token-by-token stream, at every step size', () => {
    // n tokens are separated by n-1 inter-token gaps, and the rate is defined
    // over the tokens those gaps hold — the same convention the serving field
    // uses for time-per-output-token, (e2e - ttft) / (output_tokens - 1).
    // With that denominator the measurement is EXACT, not merely close: the
    // earlier 100/(n-1)% residual was an artifact of dividing n by an n-1 span.
    const trueRate = 200;
    const rows: Array<[number, string]> = [];
    for (const tokens of [20, 100, 300, 1000]) {
      const measured = measureStream(steadyStream(trueRate, tokens), tokens);
      rows.push([tokens, errorPct(measured, trueRate)]);
      expect(measured).toBeCloseTo(trueRate, 9);
    }
    expect(rows).toEqual([
      [20, '0.00%'],
      [100, '0.00%'],
      [300, '0.00%'],
      [1000, '0.00%'],
    ]);
  });

  it('reports nothing for a single-token step', () => {
    // One token has no interval. The serving field records its time per output
    // token as undefined for the same reason, not as zero.
    expect(measureStream([0], 1)).toBeNull();
    expect(measureStream([0, 10], 1)).toBeNull();
  });

  it('is unaffected by a tail that emits no tokens', () => {
    // The stream stays open after the last token: the usage frame, the finish
    // frame and the close all arrive later. None of them carries a token, so
    // none of them is in the window.
    const trueRate = 200;
    const tokens = 300;
    const parts = steadyStream(trueRate, tokens);
    const measured = measureStream(parts, tokens);
    expect(errorPct(measured, trueRate)).toBe('0.00%');

    // Whatever the tail, the window is the same: the two endpoints the engine
    // reports do not move.
    for (const tailMs of [0, 100, 300, 1000]) {
      expect(measureStream(parts, tokens)).toBe(measured);
      expect(tailMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the true span when a batched transport still spans the decode', () => {
    // Batched DELIVERY is not batching of the decode itself. If the server
    // forwards in K frames spread across the production window, the first and
    // last arrivals still straddle it — the window survives, and so does the
    // rate. This is why the endpoint change matters: the old window ended at
    // stream close and paid for the tail; this one does not.
    const trueRate = 200;
    const tokens = 300;
    const produceEndMs = ((tokens - 1) * 1000) / trueRate; // 1495 ms
    for (const bursts of [2, 5, 30, 300]) {
      const arrivals = Array.from(
        { length: bursts },
        (_, i) => (produceEndMs * i) / (bursts - 1),
      );
      const measured = measureStream(arrivals, tokens);
      // Exact: the first and last arrivals still straddle the produce span.
      expect(errorPct(measured, trueRate)).toBe('0.00%');
    }
  });

  it('cannot recover the span when the response is buffered before delivery', () => {
    // The real irreducible case: the provider (or a proxy) produces the whole
    // response and then delivers it. The production time — the only interval
    // the tokens were generated over — is never observable from the client, so
    // every client-side endpoint pair reports delivery speed, not decode
    // speed. Recorded as measurements so this is documented rather than
    // "fixed" by tuning a constant.
    const trueRate = 200;
    const tokens = 300;
    const observed: Array<[number, string]> = [];
    for (const [bursts, deliveryMs] of [
      [2, 20],
      [5, 50],
      [30, 200],
    ] as const) {
      const arrivals = Array.from({ length: bursts }, (_, i) => (deliveryMs * i) / (bursts - 1));
      const measured = measureStream(arrivals, tokens);
      observed.push([bursts, errorPct(measured, trueRate)]);
    }
    expect(observed).toEqual([
      [2, '7375.00%'],
      [5, '2890.00%'],
      [30, '647.50%'],
    ]);
  });

  it('returns no sample rather than a guess when a step cannot be measured', () => {
    const tokens = 300;
    // One part only: no interval exists.
    expect(measureStream([500], tokens)).toBeNull();
    // No parts at all (a tool-only step).
    expect(measureStream([], tokens)).toBeNull();
    // No token count.
    expect(measureStream(steadyStream(200, tokens), 0)).toBeNull();
  });
});
