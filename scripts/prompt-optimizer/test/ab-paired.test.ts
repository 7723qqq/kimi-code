import { describe, expect, test } from 'bun:test';

import {
  PairingError,
  estimatePower,
  pairedDifferences,
  pairedPermutationP,
  standardDeviation,
} from '../src/ab-test/statistics';

/** Deterministic RNG so permutation results are reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('pairedDifferences', () => {
  test('subtracts per case, not per index', () => {
    // Same ids, deliberately different insertion order.
    const a = new Map([
      ['c1', [1]],
      ['c2', [0]],
    ]);
    const b = new Map([
      ['c2', [1]],
      ['c1', [1]],
    ]);
    // c1: 0, c2: +1 -> sorted by id
    expect(pairedDifferences({ a, b })).toEqual([0, 1]);
  });

  test('averages repetitions per case', () => {
    const a = new Map([['c1', [0, 1, 0]]]);
    const b = new Map([['c1', [1, 1, 1]]]);
    expect(pairedDifferences({ a, b })[0]).toBeCloseTo(1 - 1 / 3, 10);
  });

  // A missing case means the variants were not compared on equal footing.
  test('refuses mismatched case sets and names the missing ids', () => {
    const a = new Map([
      ['c1', [1]],
      ['onlyA', [1]],
    ]);
    const b = new Map([
      ['c1', [1]],
      ['onlyB', [1]],
    ]);
    expect(() => pairedDifferences({ a, b })).toThrow(PairingError);
    expect(() => pairedDifferences({ a, b })).toThrow(/onlyA/);
    expect(() => pairedDifferences({ a, b })).toThrow(/onlyB/);
  });
});

describe('pairedPermutationP', () => {
  test('an identical pair yields p = 1', () => {
    expect(pairedPermutationP([0, 0, 0, 0], 500, seeded(1))).toBe(1);
  });

  test('no cases yields p = 1', () => {
    expect(pairedPermutationP([], 500, seeded(1))).toBe(1);
  });

  test('a consistent positive shift is significant', () => {
    const diffs = Array.from({ length: 30 }, () => 0.05);
    expect(pairedPermutationP(diffs, 2000, seeded(2))).toBeLessThan(0.05);
  });

  test('noise centred on zero is not significant', () => {
    const rng = seeded(3);
    const diffs = Array.from({ length: 30 }, () => (rng() < 0.5 ? -0.1 : 0.1));
    expect(pairedPermutationP(diffs, 2000, seeded(4))).toBeGreaterThan(0.05);
  });

  test('p never reports exactly zero for a finite number of draws', () => {
    const diffs = Array.from({ length: 50 }, () => 1);
    expect(pairedPermutationP(diffs, 200, seeded(5))).toBeGreaterThan(0);
  });
});

describe('the change this guards: paired detects what unpaired cannot', () => {
  /**
   * The reported defect. Both variants run the same cases, so per-case
   * difficulty is shared. With n=35 a modest improvement is invisible to an
   * unpaired test but obvious to a paired one.
   */
  test('a +0.05 consistent shift over 35 cases is detected by the paired test', () => {
    // Per-case difficulty varies; the variant adds a small constant.
    const rng = seeded(7);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 35; i++) {
      const base = 0.65 - 0.5 * rng() + (rng() - 0.5) * 0.1;
      const clamped = Math.max(0, Math.min(1, base));
      a.push(clamped);
      b.push(Math.min(1, clamped + 0.05));
    }

    const differences = b.map((v, i) => v - a[i]!);
    expect(pairedPermutationP(differences, 2000, seeded(8))).toBeLessThan(0.05);

    // And the paired spread is far tighter than the raw spread the unpaired
    // test would work against — this is the variance the old code discarded.
    const pairedSpread = standardDeviation(differences);
    const rawSpread = standardDeviation(a);
    expect(pairedSpread).toBeLessThan(rawSpread / 2);
  });
});

describe('estimatePower', () => {
  test('reports n and a positive detectable effect', () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5];
    const power = estimatePower(values, undefined);
    expect(power.n).toBe(5);
    expect(power.detectableDelta).toBeGreaterThan(0);
    expect(power.alpha).toBe(0.05);
  });

  test('a larger sample detects a smaller effect', () => {
    const small = estimatePower(Array.from({ length: 10 }, (_, i) => i / 10), undefined);
    const large = estimatePower(Array.from({ length: 200 }, (_, i) => i / 200), undefined);
    expect(large.detectableDelta).toBeLessThan(small.detectableDelta);
  });

  test('the paired spread gives a smaller detectable effect than the raw spread', () => {
    const raw = Array.from({ length: 35 }, (_, i) => i / 35);
    const diffs = Array.from({ length: 35 }, () => 0.05);
    expect(estimatePower(raw, diffs).detectableDelta).toBeLessThan(
      estimatePower(raw, undefined).detectableDelta,
    );
  });

  test('an empty sample does not produce NaN or Infinity silently', () => {
    const power = estimatePower([], undefined);
    expect(power.n).toBe(0);
    expect(Number.isNaN(power.detectableDelta)).toBe(false);
    expect(power.detectableDelta).toBe(Number.POSITIVE_INFINITY);
  });

  test('a single case has no spread to speak of', () => {
    const power = estimatePower([1], undefined);
    expect(power.sigma).toBe(0);
    expect(Number.isNaN(power.detectableDelta)).toBe(false);
  });
});
