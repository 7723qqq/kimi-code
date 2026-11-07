import { tokenize } from '@moonshot-ai/minidb';

import type { Atom, AssociativeMemoryParams } from './types';
import { tfidf } from './vector';

export interface NoteSegment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function trimSpan(source: string, start: number, end: number): NoteSegment {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(source[from]!)) from += 1;
  while (to > from && /\s/.test(source[to - 1]!)) to -= 1;
  return { text: source.slice(from, to), start: from, end: to };
}

function pushSplitSegments(
  source: string,
  start: number,
  end: number,
  maxChars: number,
  out: NoteSegment[],
): void {
  const length = end - start;
  if (maxChars <= 0 || length <= maxChars) {
    const segment = trimSpan(source, start, end);
    if (segment.text.length > 0) out.push(segment);
    return;
  }
  const slice = source.slice(start, end);
  const sentenceRe = /[^.!?。！？]+[.!?。！？]*/g;
  let bufferStart = -1;
  let bufferEnd = -1;
  const flush = (): void => {
    if (bufferStart < 0) return;
    const segment = trimSpan(source, start + bufferStart, start + bufferEnd);
    if (segment.text.length > 0) out.push(segment);
    bufferStart = -1;
    bufferEnd = -1;
  };
  let match: RegExpExecArray | null;
  while ((match = sentenceRe.exec(slice)) !== null) {
    const sentenceStart = match.index;
    const sentenceEnd = match.index + match[0].length;
    if (bufferStart >= 0 && bufferEnd - bufferStart + (sentenceEnd - sentenceStart) > maxChars) {
      flush();
    }
    if (sentenceEnd - sentenceStart > maxChars) {
      flush();
      for (let cursor = sentenceStart; cursor < sentenceEnd; cursor += maxChars) {
        const segment = trimSpan(source, start + cursor, start + Math.min(sentenceEnd, cursor + maxChars));
        if (segment.text.length > 0) out.push(segment);
      }
      continue;
    }
    if (bufferStart < 0) bufferStart = sentenceStart;
    bufferEnd = sentenceEnd;
  }
  flush();
}

export function splitNoteSpans(text: string, maxChars: number): NoteSegment[] {
  const out: NoteSegment[] = [];
  let offset = 0;
  let groupStart = -1;
  let groupEnd = -1;
  const closeGroup = (): void => {
    if (groupStart < 0) return;
    pushSplitSegments(text, groupStart, groupEnd, maxChars, out);
    groupStart = -1;
    groupEnd = -1;
  };
  for (const line of text.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      closeGroup();
      continue;
    }
    if (trimmed.startsWith('#')) {
      closeGroup();
      groupStart = lineStart;
      groupEnd = lineEnd;
      continue;
    }
    if (groupStart < 0) groupStart = lineStart;
    groupEnd = lineEnd;
  }
  closeGroup();
  return out;
}

export function splitNote(text: string, maxChars: number): string[] {
  return splitNoteSpans(text, maxChars).map((segment) => segment.text);
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
  const segments = splitNoteSpans(note.text, params.maxAtomChars);
  return segments.map((segment, index) => {
    const terms = tokenize(segment.text);
    return {
      id: atomId(note.scopeKey, note.id, index),
      noteId: note.id,
      scopeKey: note.scopeKey,
      nodeType: 'atom' as const,
      text: segment.text,
      spanStart: segment.start,
      spanEnd: segment.end,
      terms,
      vector: tfidf(terms, df, totalDocs),
      denseVector: undefined,
      conceptId: undefined,
      baseWeight: 1,
      confidence: 0.5,
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
