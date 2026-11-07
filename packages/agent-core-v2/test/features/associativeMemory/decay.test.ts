import { describe, expect, it } from 'bun:test';

import {
  applyDecay,
  decayFactor,
  pruneCooccurrences,
  pruneEdges,
} from '#/features/associativeMemory/decay';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Cooccurrence, Edge } from '#/features/associativeMemory/types';

const DAY = 24 * 60 * 60 * 1000;

function edge(id: string, weight: number, lastUsedAt: number, from = 'a', to = 'b'): Edge {
  return {
    id,
    from,
    to,
    kind: 'hebbian',
    weight,
    strengthenCount: 1,
    validFrom: 0,
    validUntil: undefined,
    createdAt: 0,
    lastUsedAt,
  };
}

describe('decayFactor', () => {
  it('decays slower than exponential in the early phase', () => {
    const age = 15 * DAY;
    const exponential = Math.pow(0.5, age / ASSOCIATIVE_MEMORY_PARAMS.halfLifeMs);
    expect(decayFactor(age, ASSOCIATIVE_MEMORY_PARAMS)).toBeGreaterThan(exponential);
  });

  it('scales the decay slope with the concept formation rate', () => {
    const edges = [edge('a>b', 1, 0)];
    const fast = applyDecay(edges, 60 * DAY, ASSOCIATIVE_MEMORY_PARAMS, new Set(), 1.5);
    const slow = applyDecay(edges, 60 * DAY, ASSOCIATIVE_MEMORY_PARAMS, new Set(), 0.5);
    expect(fast[0]!.weight).toBeLessThan(slow[0]!.weight);
  });

  it('switches to exponential after the power-law window', () => {
    const t = ASSOCIATIVE_MEMORY_PARAMS.powerLawDays * DAY;
    const boundary = decayFactor(t, ASSOCIATIVE_MEMORY_PARAMS);
    const later = decayFactor(t + ASSOCIATIVE_MEMORY_PARAMS.halfLifeMs, ASSOCIATIVE_MEMORY_PARAMS);
    expect(later).toBeCloseTo(boundary / 2, 5);
  });
});

describe('applyDecay', () => {
  it('does not decay pinned nodes', () => {
    const edges = [edge('a>b', 1, 0)];
    const decayed = applyDecay(edges, 10 * DAY, ASSOCIATIVE_MEMORY_PARAMS, new Set(['a']));
    expect(decayed[0]?.weight).toBe(1);
  });

  it('does not zero a suppressed edge (channels are orthogonal)', () => {
    const edges = [edge('a>b', 1, 0)];
    const decayed = applyDecay(edges, 10 * DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(decayed[0]?.weight).toBeGreaterThan(0);
  });

  it('decays expired edges too so they can eventually be pruned', () => {
    const expired = { ...edge('x>y', 1, 0), validUntil: 5 };
    const decayed = applyDecay([expired], 400 * DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(decayed[0]?.weight).toBeLessThan(ASSOCIATIVE_MEMORY_PARAMS.pruneThreshold);
  });
});

describe('pruneEdges', () => {
  it('drops any edge below the threshold, expired or not', () => {
    const expired = { ...edge('x>y', 0.01, 0), validUntil: 5 };
    const kept = pruneEdges(
      [edge('a>b', 0.5, 0), edge('c>d', 0.01, 0), expired],
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    expect(kept.map((entry) => entry.id)).toEqual(['a>b']);
  });
});

describe('decay consolidation', () => {
  it('keeps a repeatedly reinforced edge heavier than a fresh one of the same age', () => {
    const fresh = { ...edge('e1', 1, 0), strengthenCount: 0 };
    const reinforced = { ...edge('e2', 1, 0), strengthenCount: 50 };
    const [decayedFresh, decayedReinforced] = applyDecay(
      [fresh, reinforced],
      90 * DAY,
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    expect(decayedReinforced!.weight).toBeGreaterThan(decayedFresh!.weight);
  });

  it('still decays a reinforced edge over a year', () => {
    const reinforced = { ...edge('e', 1, 0), strengthenCount: 50 };
    const [decayed] = applyDecay([reinforced], 365 * DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(decayed!.weight).toBeGreaterThan(0);
    expect(decayed!.weight).toBeLessThan(1);
  });

  it('keeps an edge with a salient endpoint heavier than a plain one of the same age', () => {
    const plain = { ...edge('e1', 1, 0), strengthenCount: 1 };
    const salient = { ...edge('e2', 1, 0, 'salient', 'b'), strengthenCount: 1 };
    const salience = new Map([
      ['salient', 4],
      ['a', 1],
      ['b', 1],
    ]);
    const [decayedPlain, decayedSalient] = applyDecay(
      [plain, salient],
      120 * DAY,
      ASSOCIATIVE_MEMORY_PARAMS,
      new Set(),
      1,
      salience,
    );
    expect(decayedSalient!.weight).toBeGreaterThan(decayedPlain!.weight);
  });

  it('still decays a salient edge over a year', () => {
    const salient = { ...edge('e', 1, 0, 'salient', 'b'), strengthenCount: 1 };
    const [decayed] = applyDecay(
      [salient],
      365 * DAY,
      ASSOCIATIVE_MEMORY_PARAMS,
      new Set(),
      1,
      new Map([['salient', 4]]),
    );
    expect(decayed!.weight).toBeGreaterThan(0);
    expect(decayed!.weight).toBeLessThan(1);
  });

  it('keeps a co-occurrence only while it is fresh or has reached the threshold', () => {
    const cooc = (key: string, count: number, lastAt: number): Cooccurrence => ({
      key,
      a: 'a',
      b: 'b',
      count,
      lastAt,
    });
    const half = ASSOCIATIVE_MEMORY_PARAMS.halfLifeMs;
    const rows = [
      cooc('stale-once', 1, 1_000),
      cooc('fresh-once', 1, 1_000 + half),
      cooc('stale-repeated', 3, 1_000),
    ];
    const kept = pruneCooccurrences(rows, 1_000 + half + 1, ASSOCIATIVE_MEMORY_PARAMS, 3);
    expect(kept.map((entry) => entry.key)).toEqual(['fresh-once', 'stale-repeated']);
  });
});
