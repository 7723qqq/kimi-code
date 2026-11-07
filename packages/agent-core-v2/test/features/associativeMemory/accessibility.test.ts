import { describe, expect, it } from 'bun:test';

import { accessibility } from '#/features/associativeMemory/accessibility';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Atom, Edge } from '#/features/associativeMemory/types';

const DAY = 24 * 60 * 60 * 1000;

function atom(id: string, lastActivatedAt: number, baseWeight = 1): Atom {
  return {
    id,
    noteId: `note-${id}`,
    scopeKey: 'proj',
    nodeType: 'atom',
    text: `text ${id}`,
    spanStart: 0,
    spanEnd: 1,
    terms: ['term'],
    vector: { term: 1 },
    denseVector: undefined,
    conceptId: undefined,
    baseWeight,
    confidence: 1,
    replayPriority: 0,
    pinned: false,
    suppressed: false,
    validFrom: 0,
    validUntil: undefined,
    isDeleted: false,
    createdAt: 0,
    lastActivatedAt,
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

describe('accessibility', () => {
  it('rates a well connected atom above an isolated one at the same age', () => {
    const target = atom('a', 0);
    const lonely = atom('b', 0);
    const edges = [edge('e1', 'a', 'c', 1), edge('e2', 'd', 'a', 1)];

    const connected = accessibility(target, edges, DAY, ASSOCIATIVE_MEMORY_PARAMS);
    const isolated = accessibility(lonely, edges, DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(connected).toBeGreaterThan(isolated);
  });

  it('rates an older atom below a fresher one with the same structure', () => {
    const fresh = atom('a', 90 * DAY);
    const stale = atom('b', 0);
    const edges = [edge('e1', 'a', 'b', 1)];

    const freshScore = accessibility(fresh, edges, 90 * DAY, ASSOCIATIVE_MEMORY_PARAMS);
    const staleScore = accessibility(stale, edges, 90 * DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(freshScore).toBeGreaterThan(staleScore);
  });

  it('rates a salient atom above a plain one with the same structure and age', () => {
    const salient = atom('a', 0, 3);
    const plain = atom('b', 0, 1);

    const salientScore = accessibility(salient, [], DAY, ASSOCIATIVE_MEMORY_PARAMS);
    const plainScore = accessibility(plain, [], DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(salientScore).toBeGreaterThan(plainScore);
  });

  it('is deterministic for identical input', () => {
    const target = atom('a', 0);
    const edges = [edge('e1', 'a', 'c', 0.5)];
    const first = accessibility(target, edges, DAY, ASSOCIATIVE_MEMORY_PARAMS);
    const second = accessibility(target, edges, DAY, ASSOCIATIVE_MEMORY_PARAMS);
    expect(second).toBe(first);
  });
});
