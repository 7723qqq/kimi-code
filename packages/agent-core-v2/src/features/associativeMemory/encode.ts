import { tokenize } from '@moonshot-ai/minidb';

import type { Atom, AssociativeMemoryParams } from './types';
import { tfidf } from './vector';

export function splitNote(text: string, maxChars: number): string[] {
  const segments: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.trim().length > 0) segments.push(current.trim());
      current = '';
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (current.trim().length > 0) segments.push(current.trim());
      current = trimmed;
      continue;
    }
    current = current.length === 0 ? trimmed : `${current} ${trimmed}`;
  }
  if (current.trim().length > 0) segments.push(current.trim());

  const out: string[] = [];
  for (const segment of segments) pushSplit(segment, maxChars, out);
  return out;
}

function pushSplit(text: string, maxChars: number, out: string[]): void {
  if (maxChars <= 0 || text.length <= maxChars) {
    out.push(text);
    return;
  }
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [text];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer.length + sentence.length > maxChars && buffer.length > 0) {
      out.push(buffer.trim());
      buffer = '';
    }
    if (sentence.length > maxChars) {
      for (let i = 0; i < sentence.length; i += maxChars) {
        out.push(sentence.slice(i, i + maxChars));
      }
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim().length > 0) out.push(buffer.trim());
}

export function atomId(scopeKey: string, noteId: string, ordinal: number): string {
  return new Bun.CryptoHasher('sha256')
    .update(`${scopeKey}\u0000${noteId}\u0000${String(ordinal)}`)
    .digest('hex')
    .slice(0, 24);
}

export function encodeAtoms(
  note: { readonly id: string; readonly scopeKey: string; readonly text: string },
  df: ReadonlyMap<string, number>,
  totalDocs: number,
  now: number,
  params: AssociativeMemoryParams,
): Atom[] {
  const segments = splitNote(note.text, params.maxAtomChars);
  return segments.map((segment, index) => {
    const terms = tokenize(segment);
    return {
      id: atomId(note.scopeKey, note.id, index),
      noteId: note.id,
      scopeKey: note.scopeKey,
      nodeType: 'atom' as const,
      text: segment,
      terms,
      vector: tfidf(terms, df, totalDocs),
      denseVector: undefined,
      conceptId: undefined,
      baseWeight: 1,
      confidence: 1,
      replayPriority: 0,
      pinned: false,
      suppressed: false,
      validFrom: now,
      validUntil: undefined,
      isDeleted: false,
      createdAt: now,
      lastActivatedAt: now,
    };
  });
}
