import { describe, expect, it } from 'bun:test';

import { clusterIncremental } from '#/features/associativeMemory/cluster';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { AssociativeMemoryParams, Atom, Cooccurrence, Concept } from '#/features/associativeMemory/types';

function atom(id: string, vector: Record<string, number>): Atom {
  return {
    id,
    noteId: `n:${id}`,
    scopeKey: 'proj',
    nodeType: 'atom', spanStart: 0, spanEnd: 0,
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

function cooc(a: string, b: string, count: number): Cooccurrence {
  const [first, second] = a < b ? [a, b] : [b, a];
  return { key: `${first}|${second}`, a: first, b: second, count, lastAt: 0 };
}

function params(overrides: Partial<AssociativeMemoryParams> = {}): AssociativeMemoryParams {
  return { ...ASSOCIATIVE_MEMORY_PARAMS, ...overrides };
}

describe('clusterIncremental', () => {
  it('creates a concept when cooccurrence reaches the threshold', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { y: 1 }), atom('a3', { z: 1 })];
    const result = clusterIncremental(
      atoms,
      [cooc('a1', 'a2', 3), cooc('a2', 'a3', 3)],
      [],
      params(),
      10,
    );
    expect(result.concepts.length).toBe(1);
    expect(result.concepts[0]?.atomIds).toEqual(['a1', 'a2', 'a3']);
    expect(result.concepts[0]?.labelSource).toBe('deterministic_v1');
    expect(result.concepts[0]?.label.length).toBeGreaterThan(0);
    expect(result.edges.every((edge) => edge.kind === 'concept')).toBe(true);
  });

  it('ignores components below the cooccurrence threshold', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { y: 1 })];
    const result = clusterIncremental(atoms, [cooc('a1', 'a2', 2)], [], params(), 10);
    expect(result.concepts.length).toBe(0);
  });

  it('splits components that exceed the capacity', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { x: 1 }), atom('a3', { x: 1 })];
    const result = clusterIncremental(
      atoms,
      [cooc('a1', 'a2', 3), cooc('a2', 'a3', 3)],
      [],
      params({ clusterMaxSize: 2 }),
      10,
    );
    expect(result.concepts.length).toBe(2);
    const sizes = result.concepts.map((concept) => concept.atomIds.length).toSorted();
    expect(sizes).toEqual([1, 2]);
  });

  it('gives a loaded concept a lower readiness than a fresh node', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { x: 1 }), atom('a3', { x: 1 })];
    const result = clusterIncremental(
      atoms,
      [cooc('a1', 'a2', 3), cooc('a2', 'a3', 3)],
      [],
      params(),
      10,
    );
    const readiness = result.concepts[0]?.readiness ?? 1;
    const fresh = 1 / (1 + 0 / params().loadRef);
    expect(readiness).toBeLessThan(fresh);
  });

  it('is deterministic', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { y: 1 }), atom('a3', { z: 1 })];
    const coocs = [cooc('a1', 'a2', 3), cooc('a2', 'a3', 3)];
    const a = clusterIncremental(atoms, coocs, [], params(), 10);
    const b = clusterIncremental(atoms, coocs, [], params(), 10);
    expect(a.concepts.map((concept) => concept.id)).toEqual(b.concepts.map((concept) => concept.id));
  });

  it('conceptFormationRate modulates the cooccurrence threshold', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { x: 1 }), atom('a3', { x: 1 })];
    const coocs = [cooc('a1', 'a2', 2), cooc('a2', 'a3', 2)];
    const aggressive = clusterIncremental(atoms, coocs, [], params({ conceptFormationRate: 1 }), 10);
    expect(aggressive.concepts.length).toBe(1);
    const conservative = clusterIncremental(atoms, coocs, [], params({ conceptFormationRate: 0 }), 10);
    expect(conservative.concepts.length).toBe(0);
  });

  it('merges a new cluster into an existing concept that shares terms and has capacity', () => {
    const atoms = [atom('a1', { x: 1 }), atom('a2', { x: 1 }), atom('a4', { x: 1 })];
    const existing: Concept = {
      id: 'c1',
      scopeKey: 'proj',
      nodeType: 'concept',
      label: 'x',
      labelSource: 'deterministic_v1',
      terms: ['x'],
      vector: { x: 1 },
      denseVector: undefined,
      atomIds: ['a4'],
      load: 1,
      readiness: 1 / (1 + 1 / params().loadRef),
      pinned: false,
      suppressed: false,
      validFrom: 0,
      validUntil: undefined,
      createdAt: 0,
      lastActivatedAt: 0,
    };
    const result = clusterIncremental(
      atoms,
      [cooc('a1', 'a2', 3)],
      [existing],
      params({ clusterMinSize: 2 }),
      10,
    );
    const merged = result.concepts.find((concept) => concept.id === 'c1');
    expect(merged?.atomIds).toEqual(['a4', 'a1', 'a2']);
  });
});
