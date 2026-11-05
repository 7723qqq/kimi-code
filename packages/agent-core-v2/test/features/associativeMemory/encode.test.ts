import { describe, expect, it } from 'bun:test';

import { atomId, encodeAtoms, splitNote } from '#/features/associativeMemory/encode';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';

describe('splitNote', () => {
  it('splits on blank lines and headings', () => {
    const out = splitNote('# Title\nfirst paragraph\n\nsecond paragraph', 400);
    expect(out).toEqual(['# Title first paragraph', 'second paragraph']);
  });

  it('caps long paragraphs by sentence', () => {
    const out = splitNote('one. two. three. four.', 8);
    expect(out.length).toBeGreaterThan(1);
    for (const segment of out) expect(segment.length).toBeLessThanOrEqual(8);
  });

  it('returns empty for blank input', () => {
    expect(splitNote('   \n  \n', 400)).toEqual([]);
  });
});

describe('encodeAtoms', () => {
  const note = { id: 'n1', scopeKey: 'proj', text: 'hello world\n\nsecond fact' };

  it('produces one atom per segment with terms and vector', () => {
    const atoms = encodeAtoms(note, new Map(), 1, 10, ASSOCIATIVE_MEMORY_PARAMS);
    expect(atoms.length).toBe(2);
    expect(atoms[0]?.terms).toEqual(['hello', 'world']);
    expect(atoms[0]?.vector['hello']).toBeGreaterThan(0);
    expect(atoms[0]?.validFrom).toBe(10);
    expect(atoms[0]?.isDeleted).toBe(false);
  });

  it('is deterministic', () => {
    const a = encodeAtoms(note, new Map(), 1, 10, ASSOCIATIVE_MEMORY_PARAMS);
    const b = encodeAtoms(note, new Map(), 1, 10, ASSOCIATIVE_MEMORY_PARAMS);
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    expect(a.map((x) => x.vector)).toEqual(b.map((x) => x.vector));
  });

  it('derives ids from scope, note and ordinal', () => {
    expect(atomId('proj', 'n1', 0)).toBe(atomId('proj', 'n1', 0));
    expect(atomId('proj', 'n1', 0)).not.toBe(atomId('proj', 'n1', 1));
    expect(atomId('proj', 'n1', 0)).not.toBe(atomId('other', 'n1', 0));
  });
});
