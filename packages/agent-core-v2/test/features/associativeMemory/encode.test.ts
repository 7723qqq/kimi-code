import { describe, expect, it } from 'bun:test';

import { atomId, encodeAtoms, splitNote, splitNoteSpans } from '#/features/associativeMemory/encode';
import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';

describe('splitNote', () => {
  it('splits on blank lines and keeps a heading with its paragraph', () => {
    const out = splitNote('# Title\nfirst paragraph\n\nsecond paragraph', 400);
    expect(out).toEqual(['# Title\nfirst paragraph', 'second paragraph']);
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

describe('splitNoteSpans', () => {
  it('returns spans whose slices reproduce the segment text', () => {
    const text = '# Title\nfirst paragraph line one\nline two\n\nsecond paragraph.\nthird sentence here.';
    const segments = splitNoteSpans(text, 40);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(text.slice(segment.start, segment.end)).toBe(segment.text);
    }
  });

  it('keeps the spans ordered and non-overlapping', () => {
    const segments = splitNoteSpans('# T\none two three.\n\nfour five six.', 12);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.start).toBeGreaterThanOrEqual(segments[index - 1]!.end);
    }
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
