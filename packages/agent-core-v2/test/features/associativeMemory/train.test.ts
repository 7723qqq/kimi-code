import { describe, expect, it } from 'bun:test';

import { recentActivity } from '#/features/associativeMemory/activity';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import { compareAtomTime, stdpDrive } from '#/features/associativeMemory/temporal';
import { hebbianConnect } from '#/features/associativeMemory/train';
import type { Atom, Edge } from '#/features/associativeMemory/types';

interface AtomTime {
  readonly createdAt?: number;
  readonly noteId?: string;
  readonly spanStart?: number;
}

function atom(id: string, vector: Record<string, number>, time: AtomTime = {}): Atom {
  return {
    id,
    noteId: time.noteId ?? 'n:shared',
    scopeKey: 'proj',
    nodeType: 'atom',
    spanStart: time.spanStart ?? 0,
    spanEnd: 0,
    text: id,
    terms: ['shared', ...Object.keys(vector)],
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
    createdAt: time.createdAt ?? 0,
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
    expect(strengthened?.weight).toBeCloseTo(1.475, 5);
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
    expect(other?.weight).toBeCloseTo(1 / 1.05, 5);
  });

  it('enforces the out-weight budget', () => {
    const context = Array.from({ length: 60 }, (_, i) =>
      atom(`c${String(i)}`, { [`t${String(i)}`]: 1 }),
    );
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      context,
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const total = result.edges.filter((e) => e.from === 'a1').reduce((sum, e) => sum + e.weight, 0);
    expect(total).toBeLessThanOrEqual(ASSOCIATIVE_MEMORY_PARAMS.outWeightBudget + 1e-9);
  });

  it('reports only stored edges as deleted when the out-degree trim fires', () => {
    const context = Array.from({ length: 60 }, (_, i) =>
      atom(`c${String(i)}`, { [`t${String(i)}`]: 1 }),
    );
    const fresh = hebbianConnect(
      [atom('a1', { x: 1 })],
      context,
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    expect(fresh.edges.filter((e) => e.from === 'a1').length).toBe(12);
    expect(fresh.deleted).toEqual([]);

    const stored = Array.from({ length: 20 }, (_, i) =>
      edge(`a1>c${String(i)}`, 'a1', `c${String(i)}`, 0.5),
    );
    const rebuilding = hebbianConnect(
      [atom('a1', { x: 1 })],
      context.slice(20, 22),
      stored,
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      6,
    );
    expect(rebuilding.deleted.length).toBe(10);
    for (const id of rebuilding.deleted) expect(stored.some((e) => e.id === id)).toBe(true);
  });

  it('applies heterosynaptic depression once per later connection', () => {
    const sides = [atom('a2', { y: 1 }), atom('a3', { z: 1 })];
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      sides,
      [edge('a1>old', 'a1', 'old', 1)],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const old = result.edges.find((e) => e.id === 'a1>old');
    expect(old?.weight).toBeCloseTo(1 / 1.1, 5);
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
    expect(
      result.edges.some((e) => e.kind === 'inhibits' && e.from === 'a1' && e.to === 'a2'),
    ).toBe(true);
    expect(result.superseded.get('a2')).toEqual({ validUntil: 7, suppressed: true });
  });

  it('keeps relationship edges out of heterosynaptic depression', () => {
    const concept: Edge = { ...edge('a1>c9', 'a1', 'c9', 1), kind: 'concept' };
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      [concept],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    expect(result.edges.find((e) => e.id === 'a1>c9')?.weight).toBe(1);
  });

  it('keeps relationship edges when the out-degree trim fires', () => {
    const context = Array.from({ length: 20 }, (_, i) =>
      atom(`c${String(i)}`, { [`t${String(i)}`]: 1 }),
    );
    const stored: Edge[] = [
      { ...edge('a1>old', 'a1', 'old', 1), kind: 'supersede' },
      { ...edge('a1~old', 'a1', 'old', 1), kind: 'inhibits' },
    ];
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      context,
      stored,
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    expect(
      result.edges.filter((e) => e.kind === 'supersede' || e.kind === 'inhibits'),
    ).toHaveLength(2);
    expect(result.edges.filter((e) => e.kind === 'hebbian')).toHaveLength(12);
    expect(result.deleted).toEqual([]);
  });

  it('lowers the learning rate for nodes with recent strengthening activity', () => {
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map([['a1', 1]]),
      5,
    );
    expect(result.edges.find((e) => e.id === 'a1>a2')?.weight).toBeCloseTo(0.5, 5);
  });

  it('counts only recent hebbian strengthening per source', () => {
    const recent: Edge = { ...edge('a1>x', 'a1', 'x', 1), strengthenCount: 3, lastUsedAt: 900 };
    const stale: Edge = { ...edge('a1>y', 'a1', 'y', 1), strengthenCount: 2, lastUsedAt: 100 };
    const future: Edge = { ...edge('a1>z', 'a1', 'z', 1), strengthenCount: 5, lastUsedAt: 2000 };
    const relation: Edge = {
      ...edge('a1>w', 'a1', 'w', 1),
      kind: 'concept',
      strengthenCount: 7,
    };
    expect(recentActivity([recent, stale, future, relation], 1000, 500).get('a1')).toBe(3);
  });

  it('preserves relative weights when the out-weight budget scales edges', () => {
    const params = { ...ASSOCIATIVE_MEMORY_PARAMS, outWeightBudget: 1 };
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [],
      [edge('a1>strong', 'a1', 'strong', 2), edge('a1>weak', 'a1', 'weak', 0.5)],
      params,
      new Map(),
      5,
    );
    const afterStrong = result.edges.find((e) => e.id === 'a1>strong')!.weight;
    const afterWeak = result.edges.find((e) => e.id === 'a1>weak')!.weight;
    expect(afterStrong / afterWeak).toBeCloseTo(4, 5);
    expect(afterStrong + afterWeak).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('depresses strong out-edges more than weak ones', () => {
    const result = hebbianConnect(
      [atom('a1', { x: 1 })],
      [atom('a2', { y: 1 })],
      [edge('a1>strong', 'a1', 'strong', 4), edge('a1>weak', 'a1', 'weak', 0.5)],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    );
    const strongRatio = result.edges.find((e) => e.id === 'a1>strong')!.weight / 4;
    const weakRatio = result.edges.find((e) => e.id === 'a1>weak')!.weight / 0.5;
    expect(strongRatio).toBeLessThan(weakRatio);
  });

  it('is independent of the context array order', () => {
    const run = (context: readonly Atom[]): readonly string[] =>
      hebbianConnect([atom('a1', { x: 1 })], context, [], ASSOCIATIVE_MEMORY_PARAMS, new Map(), 5)
        .edges.map((e) => `${e.id}:${e.weight.toFixed(8)}`)
        .sort();
    expect(run([atom('a2', { y: 1 }), atom('a3', { z: 1 })])).toEqual(
      run([atom('a3', { z: 1 }), atom('a2', { y: 1 })]),
    );
  });

  it('treats same-moment atoms from different notes as simultaneous', () => {
    const left = atom('a1', { x: 1 }, { createdAt: 100, noteId: 'note:a' });
    const right = atom('a2', { y: 1 }, { createdAt: 100, noteId: 'note:b' });
    expect(compareAtomTime(left, right)).toBe(0);
    expect(stdpDrive(left, right, ASSOCIATIVE_MEMORY_PARAMS)).toBe(0);
  });

  it('orders atoms inside one note by their span', () => {
    const first = atom('a1', { x: 1 }, { spanStart: 0 });
    const second = atom('a2', { y: 1 }, { spanStart: 400 });
    expect(compareAtomTime(first, second)).toBeLessThan(0);
    expect(stdpDrive(second, first, ASSOCIATIVE_MEMORY_PARAMS)).toBeGreaterThan(0);
  });

  it('strengthens forward-timed pairs and depresses reverse-timed pairs', () => {
    const candidate = atom('a1', { x: 1 }, { createdAt: 100 });
    const earlier = atom('a2', { y: 1 }, { createdAt: 0, noteId: 'note:earlier' });
    const later = atom('a3', { z: 1 }, { createdAt: 200, noteId: 'note:later' });
    const forward = hebbianConnect(
      [candidate],
      [earlier],
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    ).edges.find((e) => e.id === 'a1>a2')!.weight;
    const reverse = hebbianConnect(
      [candidate],
      [later],
      [],
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      5,
    ).edges.find((e) => e.id === 'a1>a3')!.weight;
    expect(forward).toBeGreaterThan(1);
    expect(reverse).toBeLessThan(1);
    expect(reverse).toBeGreaterThanOrEqual(0);
  });

  it('shrinks the timing bias as the temporal distance grows', () => {
    const candidate = atom('a1', { x: 1 }, { createdAt: 0 });
    const near = atom('a2', { y: 1 }, { createdAt: 1000, noteId: 'note:near' });
    const far = atom('a3', { z: 1 }, { createdAt: 86_400_000, noteId: 'note:far' });
    const weightOf = (other: Atom): number =>
      hebbianConnect([candidate], [other], [], ASSOCIATIVE_MEMORY_PARAMS, new Map(), 5).edges[0]!
        .weight;
    expect(Math.abs(weightOf(near) - 1)).toBeGreaterThan(Math.abs(weightOf(far) - 1));
  });

  it('reduces the increment as a weight approaches the ceiling', () => {
    const incrementFor = (weight: number): number => {
      const result = hebbianConnect(
        [atom('a1', { x: 1 })],
        [atom('a2', { y: 1 })],
        [edge('a1>a2', 'a1', 'a2', weight)],
        ASSOCIATIVE_MEMORY_PARAMS,
        new Map(),
        5,
      );
      return result.edges.find((e) => e.id === 'a1>a2')!.weight - weight;
    };
    expect(incrementFor(19)).toBeLessThan(incrementFor(1));
  });

  it('scales re-potentiation against the node sliding threshold', () => {
    const existing = edge('a1>a2', 'a1', 'a2', 1);
    const strongHistory: Edge = { ...edge('a1>a3', 'a1', 'a3', 1), strengthenCount: 5 };
    const weightOf = (edges: readonly Edge[]): number =>
      hebbianConnect(
        [atom('a1', { x: 1 })],
        [atom('a2', { y: 1 })],
        edges,
        ASSOCIATIVE_MEMORY_PARAMS,
        new Map(),
        5,
      ).edges.find((e) => e.id === 'a1>a2')!.weight;
    expect(weightOf([existing, strongHistory])).toBeLessThan(weightOf([existing]));
  });
});
