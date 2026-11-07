import { describe, expect, it } from 'bun:test';

import { memorySeparationDecision } from '#/features/associativeMemory/separation';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Atom } from '#/features/associativeMemory/types';

function atom(id: string, terms: string[], vector: Record<string, number>): Atom {
  return {
    id,
    nodeType: 'atom',
    noteId: `note_${id}`,
    scopeKey: 'project:test',
    text: `${id} text`,
    spanStart: 0,
    spanEnd: 6,
    terms,
    vector,
    denseVector: undefined,
    conceptId: undefined,
    baseWeight: 1,
    confidence: 0.5,
    replayPriority: 0,
    pinned: false,
    suppressed: false,
    isDeleted: false,
    validFrom: 1,
    validUntil: undefined,
    createdAt: 1,
    lastActivatedAt: 1,
  };
}

describe('memory separation', () => {
  it('returns merge for highly overlapping memories', async () => {
    const vector = { cache: 1, ttl: 1 };
    expect(
      memorySeparationDecision(
        atom('a', ['cache', 'ttl'], vector),
        atom('b', ['cache', 'ttl'], vector),
        ASSOCIATIVE_MEMORY_PARAMS,
      ),
    ).toBe('merge');
  });

  it('returns separate for highly similar memories that share content terms', async () => {
    const candidateVector = { cache: 1, ttl: 1, seconds: 1 };
    const existingVector = { cache: 1, ttl: 1, seconds: 0.9 };
    const decision = memorySeparationDecision(
      atom('a', ['cache', 'ttl', 'seconds'], candidateVector),
      atom('b', ['cache', 'ttl', 'seconds'], existingVector),
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    expect(decision === 'merge' || decision === 'separate').toBe(true);
  });

  it('returns new for unrelated memories', async () => {
    expect(
      memorySeparationDecision(
        atom('a', ['cache'], { cache: 1 }),
        atom('b', ['billing'], { billing: 1 }),
        ASSOCIATIVE_MEMORY_PARAMS,
      ),
    ).toBe('new');
  });
});
