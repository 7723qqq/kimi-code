import { MiniDb } from '@moonshot-ai/minidb';
import { join } from 'pathe';

import type { Atom, Concept, Cooccurrence, Edge, NoteRecord, Procedure } from './types';

const NOTE_PREFIX = 'note:';
const ATOM_PREFIX = 'atom:';
const CONCEPT_PREFIX = 'concept:';
const EDGE_PREFIX = 'edge:';
const COOC_PREFIX = 'cooc:';
const PROCEDURE_PREFIX = 'procedure:';

export interface ProjectMemory {
  readonly atoms: readonly Atom[];
  readonly concepts: readonly Concept[];
  readonly edges: readonly Edge[];
  readonly notes: readonly NoteRecord[];
  readonly cooccurrences: readonly Cooccurrence[];
}

export class AssociativeMemoryStore {
  private db: MiniDb | undefined;
  private readonly atoms = new Map<string, Atom>();
  private readonly concepts = new Map<string, Concept>();
  private readonly edges = new Map<string, Edge>();
  private readonly bySource = new Map<string, Set<string>>();
  private readonly notes = new Map<string, NoteRecord>();
  private readonly coocs = new Map<string, Cooccurrence>();
  private readonly procedures = new Map<string, Procedure>();

  private constructor(
    readonly scopeKey: string,
    private readonly dir: string,
  ) {}

  static async open(scopeKey: string, storeRoot: string): Promise<AssociativeMemoryStore> {
    const store = new AssociativeMemoryStore(scopeKey, join(storeRoot, scopeKey));
    store.db = await MiniDb.open({
      dir: store.dir,
      valueCodec: 'json',
      valueMode: 'memory',
      fsyncPolicy: 'everysec',
    });
    store.load();
    return store;
  }

  private load(): void {
    const db = this.requireDb();
    for (const entry of db.query({ key: { prefix: NOTE_PREFIX } })) {
      const stored = entry.value as Partial<NoteRecord>;
      if (stored.id === undefined) continue;
      const note: NoteRecord = { ...stored, source: stored.source ?? 'legacy' } as NoteRecord;
      this.notes.set(note.id, note);
    }
    for (const entry of db.query({ key: { prefix: ATOM_PREFIX } })) {
      const stored = entry.value as Partial<Atom>;
      if (stored.id === undefined) continue;
      const note = stored.noteId === undefined ? undefined : this.notes.get(stored.noteId);
      const text =
        note !== undefined && stored.spanStart !== undefined && stored.spanEnd !== undefined
          ? note.text.slice(stored.spanStart, stored.spanEnd)
          : (stored.text ?? '');
      this.atoms.set(stored.id, { ...stored, text } as Atom);
    }
    for (const entry of db.query({ key: { prefix: CONCEPT_PREFIX } })) {
      const concept = entry.value as Concept;
      this.concepts.set(concept.id, concept);
    }
    for (const entry of db.query({ key: { prefix: EDGE_PREFIX } })) {
      const edge = entry.value as Edge;
      this.edges.set(edge.id, edge);
      this.indexEdge(edge);
    }
    for (const entry of db.query({ key: { prefix: COOC_PREFIX } })) {
      const cooc = entry.value as Cooccurrence;
      this.coocs.set(cooc.key, cooc);
    }
    for (const entry of db.query({ key: { prefix: PROCEDURE_PREFIX } })) {
      const procedure = entry.value as Procedure;
      this.procedures.set(procedure.id, procedure);
    }
  }

  listAtoms(): readonly Atom[] {
    return [...this.atoms.values()];
  }

  listConcepts(): readonly Concept[] {
    return [...this.concepts.values()];
  }

  private indexEdge(edge: Edge): void {
    let ids = this.bySource.get(edge.from);
    if (ids === undefined) {
      ids = new Set();
      this.bySource.set(edge.from, ids);
    }
    ids.add(edge.id);
  }

  edgesFrom(sources: ReadonlySet<string>): readonly Edge[] {
    const out: Edge[] = [];
    for (const source of sources) {
      for (const id of this.bySource.get(source) ?? []) {
        const edge = this.edges.get(id);
        if (edge !== undefined) out.push(edge);
      }
    }
    return out;
  }

  listEdges(): readonly Edge[] {
    return [...this.edges.values()];
  }

  listNotes(): readonly NoteRecord[] {
    return [...this.notes.values()];
  }

  listCooccurrences(): readonly Cooccurrence[] {
    return [...this.coocs.values()];
  }

  listProcedures(): readonly Procedure[] {
    return [...this.procedures.values()];
  }

  getProcedure(id: string): Procedure | undefined {
    return this.procedures.get(id);
  }

  getAtom(id: string): Atom | undefined {
    return this.atoms.get(id);
  }

  getEdge(id: string): Edge | undefined {
    return this.edges.get(id);
  }

  getConcept(id: string): Concept | undefined {
    return this.concepts.get(id);
  }

  getNote(id: string): NoteRecord | undefined {
    return this.notes.get(id);
  }

  snapshot(): ProjectMemory {
    return {
      atoms: this.listAtoms(),
      concepts: this.listConcepts(),
      edges: this.listEdges(),
      notes: this.listNotes(),
      cooccurrences: this.listCooccurrences(),
    };
  }

  async putNote(note: NoteRecord): Promise<void> {
    this.notes.set(note.id, note);
    await this.requireDb().set(`${NOTE_PREFIX}${note.id}`, note);
  }

  getCooccurrence(key: string): Cooccurrence | undefined {
    return this.coocs.get(key);
  }

  async putAtom(atom: Atom): Promise<void> {
    this.atoms.set(atom.id, atom);
    const persisted: Record<string, unknown> = { ...atom };
    delete persisted['text'];
    await this.requireDb().set(`${ATOM_PREFIX}${atom.id}`, persisted);
  }

  async putConcept(concept: Concept): Promise<void> {
    this.concepts.set(concept.id, concept);
    await this.requireDb().set(`${CONCEPT_PREFIX}${concept.id}`, concept);
  }

  async putEdge(edge: Edge): Promise<void> {
    this.edges.set(edge.id, edge);
    this.indexEdge(edge);
    await this.requireDb().set(`${EDGE_PREFIX}${edge.id}`, edge);
  }

  async putCooccurrence(cooc: Cooccurrence): Promise<void> {
    this.coocs.set(cooc.key, cooc);
    await this.requireDb().set(`${COOC_PREFIX}${cooc.key}`, cooc);
  }

  async putProcedure(procedure: Procedure): Promise<void> {
    this.procedures.set(procedure.id, procedure);
    await this.requireDb().set(`${PROCEDURE_PREFIX}${procedure.id}`, procedure);
  }

  async deleteAtom(id: string): Promise<void> {
    this.atoms.delete(id);
    await this.requireDb().del(`${ATOM_PREFIX}${id}`);
  }

  async deleteEdge(id: string): Promise<void> {
    const existing = this.edges.get(id);
    if (existing !== undefined) this.bySource.get(existing.from)?.delete(id);
    this.edges.delete(id);
    await this.requireDb().del(`${EDGE_PREFIX}${id}`);
  }

  async deleteNote(id: string): Promise<void> {
    this.notes.delete(id);
    await this.requireDb().del(`${NOTE_PREFIX}${id}`);
  }

  async deleteConcept(id: string): Promise<void> {
    this.concepts.delete(id);
    await this.requireDb().del(`${CONCEPT_PREFIX}${id}`);
  }

  async deleteCooccurrence(key: string): Promise<void> {
    this.coocs.delete(key);
    await this.requireDb().del(`${COOC_PREFIX}${key}`);
  }

  async deleteProcedure(id: string): Promise<void> {
    this.procedures.delete(id);
    await this.requireDb().del(`${PROCEDURE_PREFIX}${id}`);
  }

  async clearGraph(): Promise<void> {
    const db = this.requireDb();
    for (const key of this.atoms.keys()) await db.del(`${ATOM_PREFIX}${key}`);
    for (const key of this.concepts.keys()) await db.del(`${CONCEPT_PREFIX}${key}`);
    for (const key of this.edges.keys()) await db.del(`${EDGE_PREFIX}${key}`);
    for (const key of this.coocs.keys()) await db.del(`${COOC_PREFIX}${key}`);
    for (const key of this.procedures.keys()) await db.del(`${PROCEDURE_PREFIX}${key}`);
    this.atoms.clear();
    this.concepts.clear();
    this.edges.clear();
    this.coocs.clear();
    this.procedures.clear();
  }

  async close(): Promise<void> {
    await this.db?.close();
    this.db = undefined;
  }

  private requireDb(): MiniDb {
    if (this.db === undefined) throw new Error('associative memory store is closed');
    return this.db;
  }
}
