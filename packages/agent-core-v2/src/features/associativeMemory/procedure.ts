import type { Atom, AssociativeMemoryParams, Edge, NoteRecord, Procedure } from './types';
import { averageVector, topTerms } from './vector';

export interface ProcedureResult {
  readonly procedures: readonly Procedure[];
  readonly edges: readonly Edge[];
}

export function procedureId(signature: string): string {
  return new Bun.CryptoHasher('sha256').update(signature).digest('hex').slice(0, 24);
}

export function distillProcedures(
  notes: readonly NoteRecord[],
  atoms: readonly Atom[],
  existing: readonly Procedure[],
  params: AssociativeMemoryParams,
  now: number,
): ProcedureResult {
  const atomsByNote = new Map<string, Atom[]>();
  for (const atom of atoms) {
    const list = atomsByNote.get(atom.noteId) ?? [];
    list.push(atom);
    atomsByNote.set(atom.noteId, list);
  }

  const signatures = new Map<string, { count: number; latest: NoteRecord; steps: Atom[] }>();
  for (const note of notes) {
    const noteAtoms = (atomsByNote.get(note.id) ?? []).toSorted((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (noteAtoms.length < params.procedureMinSteps) continue;
    const signature = noteAtoms
      .map((atom) => topTerms(atom.vector, 1)[0] ?? '')
      .filter((term) => term.length > 0)
      .join('|');
    if (signature.length === 0) continue;
    const entry = signatures.get(signature);
    if (entry === undefined) {
      signatures.set(signature, { count: 1, latest: note, steps: noteAtoms });
      continue;
    }
    entry.count += 1;
    if (note.createdAt >= entry.latest.createdAt) entry.latest = note;
  }

  const created: Procedure[] = [];
  const suppressedIds = new Set(
    existing.filter((procedure) => procedure.suppressed).map((procedure) => procedure.id),
  );
  for (const [signature, entry] of [...signatures.entries()].toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (entry.count < params.procedureThreshold) continue;
    if (suppressedIds.has(procedureId(signature))) continue;
    const members = entry.steps;
    const vector = averageVector(members.map((atom) => atom.vector));
    created.push({
      id: procedureId(signature),
      scopeKey: entry.latest.scopeKey,
      label: topTerms(vector, 3).join(' '),
      terms: topTerms(vector, 5),
      vector,
      stepIds: members.map((atom) => atom.id),
      sourceNoteId: entry.latest.id,
      frequency: entry.count,
      pinned: false,
      suppressed: false,
      createdAt: now,
      lastActivatedAt: now,
    });
  }

  const all = [
    ...existing.filter((procedure) => !created.some((entry) => entry.id === procedure.id)),
    ...created,
  ];
  const edges: Edge[] = [];
  for (const procedure of all) {
    for (const atomId of procedure.stepIds) {
      edges.push({
        id: `${procedure.id}>${atomId}`,
        from: procedure.id,
        to: atomId,
        kind: 'procedure',
        weight: 1,
        strengthenCount: 1,
        validFrom: procedure.createdAt,
        validUntil: undefined,
        createdAt: procedure.createdAt,
        lastUsedAt: now,
      });
    }
  }
  return { procedures: all, edges };
}
