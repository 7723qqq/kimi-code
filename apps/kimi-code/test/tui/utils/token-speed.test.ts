import { describe, expect, it } from 'vitest';

import { computeSmoothedTokenSpeed, pickDecodeMs } from '#/tui/utils/token-speed';

describe('pickDecodeMs', () => {
  it('prefers the provider-reported server decode window', () => {
    expect(pickDecodeMs(800, 50)).toBe(800);
  });

  it('falls back to the wall-clock stream duration when it is a plausible stream', () => {
    expect(pickDecodeMs(undefined, 1200)).toBe(1200);
    // Boundary: exactly MIN_STREAM_WINDOW_MS is accepted.
    expect(pickDecodeMs(undefined, 150)).toBe(150);
  });

  it('rejects collapsed wall-clock windows (cached / batched bursts)', () => {
    expect(pickDecodeMs(undefined, 120)).toBeNull();
    expect(pickDecodeMs(undefined, 30)).toBeNull();
    expect(pickDecodeMs(undefined, 1)).toBeNull();
  });

  it('treats zero / negative server decode as missing', () => {
    expect(pickDecodeMs(0, 1200)).toBe(1200);
    expect(pickDecodeMs(-1, 1200)).toBe(1200);
  });

  it('treats zero / negative stream duration as missing', () => {
    expect(pickDecodeMs(undefined, 0)).toBeNull();
    expect(pickDecodeMs(undefined, -5)).toBeNull();
  });

  it('returns null when neither field is usable', () => {
    expect(pickDecodeMs(undefined, undefined)).toBeNull();
    expect(pickDecodeMs(0, 0)).toBeNull();
  });
});

describe('computeSmoothedTokenSpeed', () => {
  it('initializes the EMA on the first valid sample', () => {
    // 100 tokens / 200 ms → 500 tok/s
    expect(computeSmoothedTokenSpeed(null, 100, 200)).toBeCloseTo(500, 6);
  });

  it('blends the new sample into the prior EMA at α = 0.4', () => {
    const prev = 100;
    // instant = 200 / 0.5 * 1000 = 400
    // smoothed = 0.4 * 400 + 0.6 * 100 = 160 + 60 = 220
    expect(computeSmoothedTokenSpeed(prev, 200, 500)).toBeCloseTo(220, 6);
  });

  it('keeps the prior EMA when the step produced no output tokens', () => {
    expect(computeSmoothedTokenSpeed(150, 0, 800)).toBe(150);
    expect(computeSmoothedTokenSpeed(150, -3, 800)).toBe(150);
  });

  it('keeps the prior EMA when the decode window is unusable', () => {
    expect(computeSmoothedTokenSpeed(150, 80, null)).toBe(150);
    expect(computeSmoothedTokenSpeed(150, 80, 0)).toBe(150);
    expect(computeSmoothedTokenSpeed(150, 80, -1)).toBe(150);
  });

  it('returns null when there is no prior EMA and the sample is unusable', () => {
    expect(computeSmoothedTokenSpeed(null, 0, 200)).toBeNull();
    expect(computeSmoothedTokenSpeed(null, 100, null)).toBeNull();
    expect(computeSmoothedTokenSpeed(null, 100, 0)).toBeNull();
  });

  it('clamps burst-step spikes toward the steady-state rate over a few steps', () => {
    // Provider batches the response: streamDurationMs collapses to 30 ms but
    // the real server-decode window is 800 ms for the same 100 tokens, so the
    // correct instant is 125 tok/s. The burst sample would have read ~3333.
    const burst = computeSmoothedTokenSpeed(null, 100, 30); // 100 / 30 ms = 3333.3
    expect(burst).not.toBeNull();
    expect(burst!).toBeGreaterThan(3000);

    // EMA at α = 0.4 halves the residual each correct sample: after n correct
    // samples the residual is (burst − 125) × 0.6^n. So ~10 correct samples
    // land within 1% of the steady state.
    let ema = burst!;
    for (let i = 0; i < 4; i++) ema = computeSmoothedTokenSpeed(ema, 100, 800)!;
    // After 4 correct samples: 125 + 3208 × 0.6^4 ≈ 540
    expect(ema).toBeLessThan(600);
    expect(ema).toBeGreaterThan(125);

    for (let i = 0; i < 11; i++) ema = computeSmoothedTokenSpeed(ema, 100, 800)!;
    // After 15 total correct samples: residual = 3208 × 0.6^15 ≈ 1.5, so ema ≈ 126.5
    expect(Math.abs(ema - 125)).toBeLessThan(5);
  });
});