import { describe, expect, it } from 'vitest';

import {
  accumulateStep,
  EMPTY_TOKEN_SPEED_TOTALS,
  measureStep,
  TokenSpeedSampler,
  tokensPerSecond,
} from '#/tui/utils/token-speed';

describe('measureStep', () => {
  it('brackets the window between the first and last token-bearing parts', () => {
    expect(measureStep(1000, 1800, 100)).toEqual({
      outputTokens: 100,
      windowTokens: 99,
      windowMs: 800,
    });
  });

  it('excludes the head wait before the first token', () => {
    expect(measureStep(1000, 1800, 100)?.windowMs).toBe(800);
    expect(measureStep(0, 1800, 100)?.windowMs).toBe(1800);
  });

  it('returns null when either endpoint is missing', () => {
    expect(measureStep(undefined, 1800, 100)).toBeNull();
    expect(measureStep(0, undefined, 100)).toBeNull();
  });

  it('returns null for a single-token step', () => {
    // One token has no interval; the serving specs record its time per output
    // token as undefined rather than zero.
    expect(measureStep(0, 100, 1)).toBeNull();
    expect(measureStep(0, 100, 0)).toBeNull();
  });

  it('returns null for a non-positive window', () => {
    expect(measureStep(800, 800, 100)).toBeNull();
    expect(measureStep(800, 100, 100)).toBeNull();
  });
});

describe('accumulateStep / tokensPerSecond', () => {
  it('sums windows and tokens across steps, then divides once', () => {
    let totals = EMPTY_TOKEN_SPEED_TOTALS;
    totals = accumulateStep(totals, measureStep(0, 800, 100)); // 99 tokens / 800 ms
    totals = accumulateStep(totals, measureStep(0, 800, 100));
    // 198 tokens over 1600 ms
    expect(tokensPerSecond(totals)).toBeCloseTo(123.75, 6);
  });

  it('skips a step with no window as a pair', () => {
    let totals = accumulateStep(EMPTY_TOKEN_SPEED_TOTALS, measureStep(0, 800, 100));
    const before = totals;
    totals = accumulateStep(totals, measureStep(undefined, 800, 500));
    // Neither the 500 tokens nor any time entered the totals: counting one
    // without the other would bias the ratio.
    expect(totals).toBe(before);
  });

  it('returns null before any step has contributed', () => {
    expect(tokensPerSecond(EMPTY_TOKEN_SPEED_TOTALS)).toBeNull();
    expect(tokensPerSecond(accumulateStep(EMPTY_TOKEN_SPEED_TOTALS, null))).toBeNull();
  });
});

describe('TokenSpeedSampler', () => {
  it('reports the cumulative rate, not the latest step', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100); // 123.75
    expect(sampler.current()).toBeCloseTo(123.75, 6);

    // A slow step pulls the session average down toward it, rather than
    // replacing the reading.
    sampler.addStep(0, 800, 100);
    sampler.addStep(0, 8000, 100); // 12.375 for this step
    const rate = sampler.current()!;
    expect(rate).toBeLessThan(123.75);
    expect(rate).toBeGreaterThan(12.375);
  });

  it('absorbs a bursty step instead of spiking', () => {
    // The live-provider failure mode: arrivals compress, one step reports a
    // very short window. A cumulative denominator damps it.
    const sampler = new TokenSpeedSampler();
    for (let i = 0; i < 10; i++) sampler.addStep(0, 1000, 100); // steady 99 tok/s
    const steady = sampler.current()!;

    sampler.addStep(0, 1, 100); // a wildly short window
    expect(sampler.current()!).toBeLessThan(steady * 1.5);
  });

  it('holds the reading when a step cannot be measured', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100);
    const settled = sampler.current();
    expect(sampler.addStep(undefined, undefined, 500)).toBe(settled);
    expect(sampler.addStep(0, 800, 1)).toBe(settled);
  });

  it('returns null until the first measurable step', () => {
    const sampler = new TokenSpeedSampler();
    expect(sampler.current()).toBeNull();
    expect(sampler.addStep(0, 800, 1)).toBeNull();
  });

  it('starts over after a reset', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100);
    sampler.reset();
    expect(sampler.current()).toBeNull();
    expect(sampler.addStep(0, 400, 100)).toBeCloseTo(247.5, 6);
  });
});
