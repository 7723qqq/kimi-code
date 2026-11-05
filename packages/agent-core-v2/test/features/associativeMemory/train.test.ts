import { describe, expect, it } from 'bun:test';

import { hebbianConnect } from '#/features/associativeMemory/train';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Atom, Edge } from '#/features/associativeMemory/types';

function atom(id: string, vector: Record<string, number>): Atom {
  return {
    id,
    noteId: `n:${id}`,
    scopeKey: 'proj',
    nodeType: 'atom',
    text: id,
    terms: Object.keys(vector),
    vector,
    denseVector: undefined,
    conceptId: undefined,
    baseWeight: 1,
    confidence: 1,
    replayPriority: 0,
    pinned: false,
    suppressed: false,
    validFrom: 0,
    validUntil: undefined,
    isDeleted: false,
    createdAt: 0,
    lastActivatedAt: 0,
  };
}

function edge(id: string, from: string, to: string, weight: number): Edge {
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
    lastUsedAt: 0,
  };
}

describe('hebbianConnect', () => {
  it('connects new atoms to context atoms with the learning rate', () => {
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const created = result.edges.find((e) => e.id === 'a1>a2');
    expect(created?.kind).toBe('hebbian');
    expect(created?.weight).toBe(1);
    expect(created?.strengthenCount).toBe(1);
  });

  it('decays the learning rate as the edge is strengthened', () => {
    const first = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const second = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      first.edges,
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      6,
    );
    const strengthened = second.edges.find((e) => e.id === 'a1>a2');
    expect(strengthened?.strengthenCount).toBe(2);
    expect(strengthened?.weight).toBeCloseTo(1.5, 5);
  });

  it('depresses other out-edges of the same source (heterosynaptic)', () => {
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      [edge('a1>a3', 'a1', 'a3', 1)],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const other = result.edges.find((e) => e.id === 'a1>a3');
    expect(other?.weight).toBeCloseTo(0.9, 5);
  });

  it('enforces the out-weight budget', () => {
    const context = Array.from({ length: 60 }, (_, i) => atom(`c${String(i)}`, { [`t${String(i)}`]: 1 }));
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      context,
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const total = result.edges
      .filter((e) => e.from === 'a1')
      .reduce((sum, e) => sum + e.weight, 0);
    expect(total).toBeLessThanOrEqual(ASSOCIATIVE_MEMORY_PARAMS.outWeightBudget + 1e-9);
  });

  it('marks the old atom superseded on contradiction without deleting it', () => {
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { x: 1 })],
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      7,
      () => true,
    );
    const supersede = result.edges.find((e) => e.id === 'a1>a2');
    expect(supersede?.kind).toBe('supersede');
    expect(result.edges.some((e) => e.kind === 'inhibits' && e.from === 'a1' && e.to === 'a2')).toBe(true);
    expect(result.superseded.get('a2')).toEqual({ validUntil: 7, suppressed: true });
  });
});
