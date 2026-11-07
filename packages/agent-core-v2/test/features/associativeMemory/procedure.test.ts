import { describe, expect, it } from 'bun:test';

import { distillProcedures, procedureId } from '#/features/associativeMemory/procedure';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import type { Atom, AssociativeMemoryParams, NoteRecord } from '#/features/associativeMemory/types';

function atom(id: string, noteId: string, vector: Record<string, number>): Atom {
  return {
    id,
    noteId,
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

function note(id: string, createdAt: number): NoteRecord {
  return { id, scopeKey: 'proj', text: id, createdAt, source: 'user' };
}

function params(overrides: Partial<AssociativeMemoryParams> = {}): AssociativeMemoryParams {
  return { ...ASSOCIATIVE_MEMORY_PARAMS, ...overrides };
}

describe('distillProcedures', () => {
  it('distills a recurring multi-step pattern into a procedure', () => {
    const atoms = [
      atom('a1', 'n1', { step: 1 }),
      atom('a2', 'n1', { one: 1 }),
      atom('a3', 'n1', { two: 1 }),
      atom('b1', 'n2', { step: 1 }),
      atom('b2', 'n2', { one: 1 }),
      atom('b3', 'n2', { two: 1 }),
    ];
    const result = distillProcedures(
      [note('n1', 1), note('n2', 2)],
      atoms,
      [],
      params(),
      10,
    );
    expect(result.procedures.length).toBe(1);
    expect(result.procedures[0]?.stepIds.length).toBe(3);
    expect(result.procedures[0]?.frequency).toBe(2);
    expect(result.edges.every((edge) => edge.kind === 'procedure')).toBe(true);
    expect(result.edges.length).toBe(3);
  });

  it('does not distill a pattern seen only once', () => {
    const atoms = [
      atom('a1', 'n1', { step: 1 }),
      atom('a2', 'n1', { one: 1 }),
      atom('a3', 'n1', { two: 1 }),
    ];
    const result = distillProcedures([note('n1', 1)], atoms, [], params(), 10);
    expect(result.procedures.length).toBe(0);
  });

  it('keeps an existing procedure instead of duplicating it', () => {
    const atoms = [
      atom('a1', 'n1', { step: 1 }),
      atom('a2', 'n1', { one: 1 }),
      atom('a3', 'n1', { two: 1 }),
      atom('b1', 'n2', { step: 1 }),
      atom('b2', 'n2', { one: 1 }),
      atom('b3', 'n2', { two: 1 }),
    ];
    const notes = [note('n1', 1), note('n2', 2)];
    const first = distillProcedures(notes, atoms, [], params(), 10);
    const second = distillProcedures(notes, atoms, first.procedures, params(), 11);
    expect(second.procedures.length).toBe(1);
    expect(second.procedures[0]?.id).toBe(first.procedures[0]?.id);
  });

  it('derives a stable id from the signature', () => {
    expect(procedureId('step|one|two')).toBe(procedureId('step|one|two'));
    expect(procedureId('step|one|two')).not.toBe(procedureId('step|one|three'));
  });
});
