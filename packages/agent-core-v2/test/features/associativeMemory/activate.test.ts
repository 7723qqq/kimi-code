import { describe, expect, it } from 'bun:test';

import { activate } from '#/features/associativeMemory/activate';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Atom, AssociativeMemoryParams, Edge, RecallQuery } from '#/features/associativeMemory/types';

function atom(id: string, terms: string[], overrides: Partial<Atom> = {}): Atom {
  return {
    id,
    noteId: `n:${id}`,
    scopeKey: 'proj',
    nodeType: 'atom',
    text: id,
    terms,
    vector: Object.fromEntries(terms.map((term) => [term, 1])),
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
    ...overrides,
  };
}

function edge(from: string, to: string, weight: number, kind: Edge['kind'] = 'hebbian'): Edge {
  return {
    id: `${from}>${to}`,
    from,
    to,
    kind,
    weight,
    strengthenCount: 1,
    validFrom: 0,
    validUntil: undefined,
    createdAt: 0,
    lastUsedAt: 0,
  };
}

function params(overrides: Partial<AssociativeMemoryParams> = {}): AssociativeMemoryParams {
  return { ...ASSOCIATIVE_MEMORY_PARAMS, ...overrides };
}

function query(cue: string, overrides: Partial<RecallQuery> = {}): RecallQuery {
  return { cue, limit: undefined, maxTokens: undefined, includeHistory: false, ...overrides };
}

describe('activate', () => {
  it('seeds from term matches', () => {
    const result = activate(
      query('hello'),
      [atom('a1', ['hello', 'world'])],
      [],
      [],
      params(),
      10,
    );
    expect(result.items.map((item) => item.id)).toEqual(['a1']);
    expect(result.trace[0]?.kind).toBe('seed');
  });

  it('spreads activation along edges with decay', () => {
    const result = activate(
      query('x'),
      [atom('a1', ['x']), atom('a2', ['y'])],
      [],
      [edge('a1', 'a2', 1)],
      params(),
      10,
    );
    const spread = result.items.find((item) => item.id === 'a2');
    expect(spread?.score).toBeCloseTo(0.5, 5);
    expect(result.trace.find((node) => node.id === 'a2')?.kind).toBe('spread');
  });

  it('gates each hop to the top-k winners', () => {
    const neighbors = Array.from({ length: 5 }, (_, i) => atom(`b${String(i)}`, [`t${String(i)}`]));
    const result = activate(
      query('x'),
      [atom('a1', ['x']), ...neighbors],
      [],
      neighbors.map((neighbor) => edge('a1', neighbor.id, 1)),
      params({ baseK: 2, kDecay: 0 }),
      10,
    );
    expect(result.trace.filter((node) => node.kind === 'spread').length).toBe(2);
  });

  it('truncates when the compute budget is exhausted', () => {
    const result = activate(
      query('x'),
      [atom('a1', ['x']), atom('a2', ['y']), atom('a3', ['z'])],
      [],
      [edge('a1', 'a2', 1), edge('a1', 'a3', 1)],
      params({ computeBudget: 2 }),
      10,
    );
    expect(result.trace.some((node) => node.truncated)).toBe(true);
  });

  it('filters expired atoms unless history is requested', () => {
    const expired = atom('a1', ['hello'], { validUntil: 5 });
    const now = params().powerLawDays * 24 * 60 * 60 * 1000;
    const hidden = activate(query('hello'), [expired], [], [], params(), now);
    expect(hidden.items).toEqual([]);
    const shown = activate(query('hello', { includeHistory: true }), [expired], [], [], params(), now);
    expect(shown.items.map((item) => item.id)).toEqual(['a1']);
  });

  it('filters deleted and suppressed atoms', () => {
    const deleted = atom('a1', ['hello'], { isDeleted: true });
    const suppressed = atom('a2', ['hello'], { suppressed: true });
    const result = activate(query('hello'), [deleted, suppressed], [], [], params(), 10);
    expect(result.items).toEqual([]);
  });

  it('keeps atoms from the top episodes only', () => {
    const a1 = atom('a1', ['x'], { noteId: 'n1' });
    const a2 = atom('a2', ['y'], { noteId: 'n1' });
    const b1 = atom('b1', ['z'], { noteId: 'n2' });
    const result = activate(query('x y z'), [a1, a2, b1], [], [], params({ episodeTopN: 1 }), 10);
    const ids = result.items.map((item) => item.id);
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');
    expect(ids).not.toContain('b1');
  });

  it('applies inhibitory edges to suppress competing nodes', () => {
    const result = activate(
      query('x'),
      [atom('a1', ['x']), atom('a2', ['x'])],
      [],
      [edge('a1', 'a2', 1, 'inhibits')],
      params(),
      10,
    );
    const a2 = result.items.find((item) => item.id === 'a2');
    expect(a2?.score).toBeCloseTo(0.5, 5);
    expect(result.trace.some((node) => node.kind === 'inhibit')).toBe(true);
  });

  it('returns conflict groups for superseded atoms', () => {
    const a1 = atom('a1', ['hello']);
    const a2 = atom('a2', ['hello']);
    const result = activate(
      query('hello'),
      [a1, a2],
      [],
      [edge('a1', 'a2', 1, 'supersede')],
      params(),
      10,
    );
    expect(result.items.length).toBe(2);
    expect(result.items[0]?.conflictGroup).toBeDefined();
    expect(result.items[1]?.conflictGroup).toBe(result.items[0]?.conflictGroup);
  });
});
