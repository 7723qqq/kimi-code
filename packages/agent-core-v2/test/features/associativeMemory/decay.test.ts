import { describe, expect, it } from 'bun:test';

import { applyDecay, decayFactor, pruneEdges } from '#/features/associativeMemory/decay';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Edge } from '#/features/associativeMemory/types';

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
