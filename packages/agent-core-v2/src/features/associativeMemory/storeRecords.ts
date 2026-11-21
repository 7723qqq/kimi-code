import type { MiniDb } from '@moonshot-ai/minidb';

import type {
  Atom,
  Concept,
  Cooccurrence,
  Edge,
  MemorySource,
  NoteRecord,
  Procedure,
} from './types';

export const RECORD_PREFIX = {
  atom: 'atom:',
  note: 'note:',
  concept: 'concept:',
  edge: 'edge:',
  cooc: 'cooc:',
  procedure: 'procedure:',
} as const;

export type StoredAtom = Omit<Atom, 'text'> & { readonly text?: string };

export interface MemoryRecords {
  atom: StoredAtom;
  note: NoteRecord;
  concept: Concept;
  edge: Edge;
  cooc: Cooccurrence;
  procedure: Procedure;
}

export type RecordKind = keyof MemoryRecords;
export type DerivedKind = Exclude<RecordKind, 'atom' | 'note'>;
export const DERIVED_KINDS = ['concept', 'procedure', 'edge', 'cooc'] as const;
export const HOT_GRAPH_LIMIT = 50_000;

export const PAGE_SIZE = 256;

export async function* pages(db: MiniDb, prefix: string) {
  const end = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
  let from: { gte: string } | { gt: string } = { gte: prefix };
  while (true) {
    const page = await db.queryAsync({ key: { ...from, lt: end }, limit: PAGE_SIZE });
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE_SIZE) return;
    from = { gt: page[page.length - 1]!.key };
  }
}

export function recordId(record: { readonly id: string } | Cooccurrence): string {
  return 'key' in record ? record.key : record.id;
}

export function isWorkingAtom(atom: StoredAtom): boolean {
  return !atom.isDeleted && !atom.suppressed && atom.validUntil === undefined;
}

export function unpackNote(note: NoteRecord): NoteRecord {
  return note.source === undefined ? { ...note, source: 'legacy' } : note;
}

function atomSpan(atom: StoredAtom, note: NoteRecord | undefined): string | undefined {
  return note !== undefined &&
    atom.spanStart >= 0 &&
    atom.spanEnd > atom.spanStart &&
    atom.spanEnd <= note.text.length
    ? note.text.slice(atom.spanStart, atom.spanEnd)
    : undefined;
}

export function unpackAtom(atom: StoredAtom, note: NoteRecord | undefined): Atom {
  return { ...atom, text: atomSpan(atom, note) ?? atom.text ?? '' };
}

export function packAtom(atom: Atom, note: NoteRecord | undefined): StoredAtom {
  const { text, ...record } = atom;
  return atomSpan(atom, note) === text ? record : atom;
}

export function emptyCounts() {
  return {
    atomRecords: 0,
    atoms: 0,
    notes: 0,
    concepts: 0,
    procedures: 0,
    edges: 0,
    cooccurrences: 0,
    suppressed: 0,
    pinned: 0,
    confidenceSum: 0,
    sourceCounts: { user: 0, tool: 0, external: 0, legacy: 0 } satisfies Record<
      MemorySource,
      number
    >,
  };
}

export type MemoryCounts = ReturnType<typeof emptyCounts>;

export function validCounts(value: unknown): value is MemoryCounts {
  if (value === null || typeof value !== 'object') return false;
  const counts = value as Record<string, unknown>;
  const { sourceCounts, ...numeric } = emptyCounts();
  if (
    !Object.keys(numeric).every(
      (key) =>
        typeof counts[key] === 'number' && Number.isFinite(counts[key]) && counts[key] >= -1e-9,
    )
  )
    return false;
  const sources = counts['sourceCounts'];
  return (
    sources !== null &&
    typeof sources === 'object' &&
    Object.keys(sourceCounts).every((key) => {
      const count = (sources as Record<string, unknown>)[key];
      return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
    })
  );
}

type CountedRecord = MemoryRecords[RecordKind];

export function countRecord(
  counts: MemoryCounts,
  kind: RecordKind,
  value: CountedRecord,
  direction: 1 | -1,
): void {
  switch (kind) {
    case 'atom': {
      const atom = value as StoredAtom;
      counts.atomRecords += direction;
      if (!atom.isDeleted) {
        counts.atoms += direction;
        if (atom.suppressed) counts.suppressed += direction;
        if (atom.pinned) counts.pinned += direction;
        counts.confidenceSum += direction * atom.confidence;
      }
      break;
    }
    case 'note':
      counts.notes += direction;
      counts.sourceCounts[(value as NoteRecord).source ?? 'legacy'] += direction;
      break;
    case 'concept': {
      const concept = value as Concept;
      counts.concepts += direction;
      if (concept.suppressed) counts.suppressed += direction;
      if (concept.pinned) counts.pinned += direction;
      break;
    }
    case 'procedure':
      counts.procedures += direction;
      break;
    case 'edge':
      counts.edges += direction;
      break;
    case 'cooc':
      counts.cooccurrences += direction;
      break;
  }
}
