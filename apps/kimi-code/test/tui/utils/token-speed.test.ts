import { describe, expect, it } from 'vitest';

import {
  accumulateStep,
  EMPTY_TOKEN_SPEED_TOTALS,
  measureStep,
  stepTokensPerSecond,
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
    expect(sampler.current().average).toBeCloseTo(123.75, 6);

    // A slow step pulls the session average down toward it, rather than
    // replacing the reading.
    sampler.addStep(0, 800, 100);
    sampler.addStep(0, 8000, 100); // 12.375 for this step
    const rate = sampler.current().average!;
    expect(rate).toBeLessThan(123.75);
    expect(rate).toBeGreaterThan(12.375);
  });

  it('absorbs a bursty step instead of spiking', () => {
    // The live-provider failure mode: arrivals compress, one step reports a
    // very short window. A cumulative denominator damps it — the step figure
    // is allowed to spike, the average is not.
    const sampler = new TokenSpeedSampler();
    for (let i = 0; i < 10; i++) sampler.addStep(0, 1000, 100); // steady 99 tok/s
    const steady = sampler.current().average!;

    sampler.addStep(0, 1, 100); // a wildly short window
    expect(sampler.current().average!).toBeLessThan(steady * 1.5);
  });

  it('holds the average when a step cannot be measured', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100);
    const settled = sampler.current().average;
    expect(sampler.addStep(undefined, undefined, 500).average).toBe(settled);
    expect(sampler.addStep(0, 800, 1).average).toBe(settled);
  });

  it('has no average until the first measurable step', () => {
    const sampler = new TokenSpeedSampler();
    expect(sampler.current().average).toBeNull();
    expect(sampler.addStep(0, 800, 1).average).toBeNull();
  });

  it('starts over after a reset', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100);
    sampler.reset();
    expect(sampler.current().average).toBeNull();
    expect(sampler.addStep(0, 400, 100).average).toBeCloseTo(247.5, 6);
  });
});

describe('stepTokensPerSecond', () => {
  it('divides the same measurement the totals are built from', () => {
    // 99 gaps over 800 ms — asserted independently of the cumulative total so
    // the two figures cannot drift apart without a test noticing.
    expect(stepTokensPerSecond(measureStep(0, 800, 100))).toBeCloseTo(123.75, 6);
  });

  it('returns null for a window too short to be trusted', () => {
    // A ~300 ms window on an endpoint batching every 310-510 ms measured 33-37%
    // high; the figure is withheld rather than shown (MIN_STEP_WINDOW_MS).
    expect(stepTokensPerSecond(measureStep(0, 300, 24))).toBeNull();
    expect(stepTokensPerSecond(measureStep(0, 499, 100))).toBeNull();
    // At and above the floor it is reported.
    expect(stepTokensPerSecond(measureStep(0, 500, 100))).not.toBeNull();
  });

  it('returns null for a step the measurement rejected', () => {
    // Not 0 and not NaN: an unmeasured step has no rate, and a zero would read
    // as a real (terrible) one.
    expect(stepTokensPerSecond(measureStep(0, 800, 1))).toBeNull();
    expect(stepTokensPerSecond(measureStep(undefined, 800, 100))).toBeNull();
    expect(stepTokensPerSecond(measureStep(0, undefined, 100))).toBeNull();
    expect(stepTokensPerSecond(measureStep(800, 800, 100))).toBeNull();
    expect(stepTokensPerSecond(null)).toBeNull();
  });
});

describe('TokenSpeedSampler readout', () => {
  it('reports the step and the session side by side', () => {
    const sampler = new TokenSpeedSampler();
    // A slow step pulls the average down toward it while the step figure is
    // the step's own.
    sampler.addStep(0, 800, 100); // 123.75 both
    const first = sampler.addStep(0, 800, 100); // 123.75 step, 123.75 average
    expect(first.step).toBeCloseTo(123.75, 6);
    expect(first.average).toBeCloseTo(123.75, 6);

    const slow = sampler.addStep(0, 8000, 100); // 12.375 step, average between
    expect(slow.step).toBeCloseTo(12.375, 6);
    expect(slow.average!).toBeGreaterThan(12.375);
    expect(slow.average!).toBeLessThan(123.75);
  });

  it('holds the step figure when a step cannot be measured', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100);
    const settled = sampler.current();

    // Bumping into a one-token step (a tool call with no prose) must not blank
    // the figure: the reply it described is still the most recent one.
    const after = sampler.addStep(0, 800, 1);
    expect(after.step).toBe(settled.step);
    expect(after.average).toBe(settled.average);

    // Nor may an unmeasured step drag the average.
    expect(sampler.addStep(undefined, undefined, 500).average).toBe(settled.average);
  });

  it('clears both figures on reset', () => {
    const sampler = new TokenSpeedSampler();
    sampler.addStep(0, 800, 100);
    sampler.reset();
    expect(sampler.current()).toEqual({ step: null, average: null });
    // 99 gaps over 800 ms = 123.75 on both figures.
    expect(sampler.addStep(0, 800, 100)).toEqual({ step: 123.75, average: 123.75 });
  });

  it('has no figures before anything has contributed', () => {
    const sampler = new TokenSpeedSampler();
    expect(sampler.current()).toEqual({ step: null, average: null });
    // A first step that cannot be measured leaves both null rather than
    // inventing one of them.
    expect(sampler.addStep(0, 800, 1)).toEqual({ step: null, average: null });
  });
});
