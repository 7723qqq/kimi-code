import { MiniDb, type BatchInputOp } from '@moonshot-ai/minidb';
import { join } from 'pathe';

import { accessibilityFromWeight } from './accessibility';
import { noteFingerprint, noteTerms } from './dedupe';
import { ASSOCIATIVE_MEMORY_PARAMS } from './params';
import {
  countRecord,
  DERIVED_KINDS,
  emptyCounts,
  HOT_GRAPH_LIMIT,
  isWorkingAtom,
  packAtom,
  pages,
  RECORD_PREFIX,
  recordId,
  unpackAtom,
  unpackNote,
  validCounts,
  type DerivedKind,
  type MemoryCounts,
  type MemoryRecords,
  type RecordKind,
  type StoredAtom,
} from './storeRecords';
import { compareByText } from './terms';
import type {
  Atom,
  Concept,
  Cooccurrence,
  Edge,
  LegacyMigrationRecord,
  NoteRecord,
  Procedure,
} from './types';

const HOT_INDEX_KEY = 'meta:hot-index';
const FINGERPRINT_PREFIX = 'fingerprint:';
const HOT_ATOM_LIMIT = 4000;
const HOT_NOTE_LIMIT = 8000;
const INDEX_VERSION = 3;

interface HotIds {
  atom: readonly string[];
  note: readonly string[];
  concept: readonly string[];
  edge: readonly string[];
  cooc: readonly string[];
  procedure: readonly string[];
}

interface HotIndex {
  readonly version: number;
  readonly noteLimit: number;
  readonly atomLimit: number;
  readonly ids: HotIds;
  readonly recentNotes: readonly string[];
  readonly counts: MemoryCounts;
}

function emptyIndex(noteLimit: number, atomLimit: number): HotIndex {
  return {
    version: INDEX_VERSION,
    noteLimit,
    atomLimit,
    ids: { atom: [], note: [], concept: [], edge: [], cooc: [], procedure: [] },
    recentNotes: [],
    counts: emptyCounts(),
  };
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validIndex(value: unknown, noteLimit: number, atomLimit: number): value is HotIndex {
  if (value === null || typeof value !== 'object') return false;
  const index = value as Record<string, unknown>;
  if (
    index['version'] !== INDEX_VERSION ||
    index['noteLimit'] !== noteLimit ||
    index['atomLimit'] !== atomLimit ||
    !strings(index['recentNotes']) ||
    index['recentNotes'].length > noteLimit ||
    !validCounts(index['counts'])
  )
    return false;
  const ids = index['ids'];
  return (
    ids !== null &&
    typeof ids === 'object' &&
    Object.keys(RECORD_PREFIX).every((kind) => strings((ids as Record<string, unknown>)[kind]))
  );
}

function newest<T extends { readonly id: string; readonly lastActivatedAt: number }>(
  a: T,
  b: T,
): number {
  return b.lastActivatedAt - a.lastActivatedAt || a.id.localeCompare(b.id);
}

function copyCounts(counts: MemoryCounts): MemoryCounts {
  return { ...counts, sourceCounts: { ...counts.sourceCounts } };
}

function distinct(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export class AssociativeMemoryStore {
  private db: MiniDb | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private hotIndex: HotIndex;
  private readonly atoms = new Map<string, Atom>();
  private readonly notes = new Map<string, NoteRecord>();
  private readonly derived = {
    concept: new Map<string, Concept>(),
    edge: new Map<string, Edge>(),
    cooc: new Map<string, Cooccurrence>(),
    procedure: new Map<string, Procedure>(),
  };
  private readonly bySource = new Map<string, Set<string>>();

  private constructor(
    readonly scopeKey: string,
    private readonly noteLimit: number,
    private readonly atomLimit: number,
  ) {
    this.hotIndex = emptyIndex(noteLimit, atomLimit);
  }

  static async open(
    scopeKey: string,
    storeRoot: string,
    noteLimit = HOT_NOTE_LIMIT,
    atomLimit = HOT_ATOM_LIMIT,
  ): Promise<AssociativeMemoryStore> {
    const store = new AssociativeMemoryStore(
      scopeKey,
      Math.max(0, noteLimit),
      Math.max(0, atomLimit),
    );
    store.db = await MiniDb.open({
      dir: join(storeRoot, scopeKey),
      valueCodec: 'json',
      valueMode: 'disk',
      fsyncPolicy: 'everysec',
    });
    try {
      const saved = await store.requireDb().getAsync(HOT_INDEX_KEY);
      if (validIndex(saved, store.noteLimit, store.atomLimit)) {
        store.hotIndex = saved;
        await store.loadHotRecords();
        await store.trimNotes();
      } else {
        await store.rebuildHotIndex();
      }
      return store;
    } catch (error) {
      await store.db.close();
      throw error;
    }
  }

  async *recordPages<K extends RecordKind>(kind: K): AsyncGenerator<MemoryRecords[K][]> {
    for await (const page of pages(this.requireDb(), RECORD_PREFIX[kind])) {
      yield page.map(
        (row) =>
          (kind === 'note' ? unpackNote(row.value as NoteRecord) : row.value) as MemoryRecords[K],
      );
    }
  }

  async *atomPages(): AsyncGenerator<Atom[]> {
    for await (const page of this.recordPages('atom')) {
      const notes = new Map<string, NoteRecord>();
      const atoms: Atom[] = [];
      for (const stored of page) {
        let note = notes.get(stored.noteId);
        if (note === undefined) {
          note = await this.getNoteById(stored.noteId);
          if (note !== undefined) notes.set(note.id, note);
        }
        atoms.push(unpackAtom(stored, note));
      }
      yield atoms;
    }
  }

  async allAtoms(): Promise<Atom[]> {
    const items: Atom[] = [];
    for await (const page of this.atomPages()) items.push(...page);
    return items;
  }

  async allRecords<K extends RecordKind>(kind: K): Promise<MemoryRecords[K][]> {
    const items: MemoryRecords[K][] = [];
    for await (const page of this.recordPages(kind)) items.push(...page);
    return items;
  }

  private async rebuildHotIndex(): Promise<void> {
    const counts = emptyCounts();
    let recent: NoteRecord[] = [];
    for await (const page of this.recordPages('note')) {
      const ops: BatchInputOp[] = [];
      for (const note of page) {
        countRecord(counts, 'note', note, 1);
        recent.push(note);
        const fingerprint = noteFingerprint(note.text);
        ops.push({ op: 'set', key: `${FINGERPRINT_PREFIX}${fingerprint}:${note.id}`, value: true });
        const legacyKey = `${FINGERPRINT_PREFIX}${fingerprint}`;
        if ((await this.requireDb().getAsync(legacyKey)) !== undefined)
          ops.push({ op: 'del', key: legacyKey });
      }
      recent
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
        .splice(this.noteLimit);
      if (ops.length > 0) await this.requireDb().batch(ops);
    }
    let active: StoredAtom[] = [];
    const pinned: StoredAtom[] = [];
    for await (const page of this.recordPages('atom')) {
      for (const atom of page) {
        countRecord(counts, 'atom', atom, 1);
        if (atom.isDeleted) continue;
        if (atom.pinned) pinned.push(atom);
        else if (isWorkingAtom(atom)) active.push(atom);
      }
      active.sort(newest).splice(this.atomLimit);
    }
    const selected = [...pinned, ...active];
    for (const stored of selected) {
      const note = await this.getNoteById(stored.noteId);
      this.atoms.set(stored.id, unpackAtom(stored, note));
    }
    for (const kind of DERIVED_KINDS) {
      for await (const page of this.recordPages(kind)) {
        for (const record of page) {
          countRecord(counts, kind, record, 1);
          if (this.eligible(kind, record)) this.cacheDerived(kind, record);
        }
      }
    }
    const recentNotes = recent.map((note) => note.id);
    const noteIds = this.requiredNoteIds(recentNotes);
    const notes = await this.readNotes(noteIds);
    const index = {
      version: INDEX_VERSION,
      noteLimit: this.noteLimit,
      atomLimit: this.atomLimit,
      ids: { ...this.hotIds(), note: [...notes.keys()] },
      recentNotes,
      counts,
    };
    await this.requireDb().batch([{ op: 'set', key: HOT_INDEX_KEY, value: index }]);
    this.hotIndex = index;
    this.publishNotes(notes);
    this.indexEdges();
  }

  private async loadHotRecords(): Promise<void> {
    for (const id of this.hotIndex.ids.note) {
      const note = await this.getNoteById(id);
      if (note !== undefined) this.notes.set(id, note);
    }
    for (const id of this.hotIndex.ids.atom) {
      const atom = await this.getAtomById(id);
      if (atom !== undefined && !atom.isDeleted) this.atoms.set(id, atom);
    }
    for (const kind of DERIVED_KINDS) {
      for (const id of this.hotIndex.ids[kind]) {
        const record = await this.readRecord(kind, id);
        if (record !== undefined) this.cacheDerived(kind, record);
      }
    }
    this.indexEdges();
  }

  private cacheDerived<K extends DerivedKind>(kind: K, record: MemoryRecords[K]): void {
    const map = this.derived[kind] as Map<string, MemoryRecords[K]>;
    const id = recordId(record);
    map.delete(id);
    map.set(id, record);
    while (map.size > HOT_GRAPH_LIMIT) {
      const removable = [...map].find(([, value]) => !('pinned' in value && value.pinned));
      if (removable === undefined) break;
      map.delete(removable[0]);
    }
  }

  private eligible(kind: DerivedKind, record: MemoryRecords[DerivedKind]): boolean {
    switch (kind) {
      case 'concept': {
        const concept = record as Concept;
        return (
          concept.pinned ||
          (!concept.suppressed &&
            concept.validUntil === undefined &&
            (concept.atomIds.length === 0 || concept.atomIds.some((id) => this.atoms.has(id))))
        );
      }
      case 'procedure': {
        const procedure = record as Procedure;
        return (
          procedure.pinned ||
          (!procedure.suppressed &&
            (procedure.stepIds.length === 0 || procedure.stepIds.some((id) => this.atoms.has(id))))
        );
      }
      case 'cooc': {
        const cooc = record as Cooccurrence;
        return this.atoms.has(cooc.a) && this.atoms.has(cooc.b);
      }
      case 'edge': {
        const edge = record as Edge;
        return [edge.from, edge.to].every((id) => {
          const atom = this.getAtom(id);
          return atom === undefined || this.atoms.has(id);
        });
      }
    }
  }

  private hotIds(): HotIds {
    return {
      atom: [...this.atoms.keys()],
      note: [...this.notes.keys()],
      concept: [...this.derived.concept.keys()],
      edge: [...this.derived.edge.keys()],
      cooc: [...this.derived.cooc.keys()],
      procedure: [...this.derived.procedure.keys()],
    };
  }

  private requiredNoteIds(
    recent: readonly string[],
    atoms = this.atoms,
    procedures = this.derived.procedure,
  ): string[] {
    return distinct([
      ...recent,
      ...[...atoms.values()].map((atom) => atom.noteId),
      ...[...procedures.values()].map((procedure) => procedure.sourceNoteId),
    ]);
  }

  private async readNotes(
    ids: readonly string[],
    incoming?: NoteRecord,
  ): Promise<Map<string, NoteRecord>> {
    const notes = new Map<string, NoteRecord>();
    for (const id of ids) {
      const note = incoming?.id === id ? incoming : await this.getNoteById(id);
      if (note !== undefined) notes.set(id, note);
    }
    return notes;
  }

  private publishNotes(notes: ReadonlyMap<string, NoteRecord>): void {
    this.notes.clear();
    for (const [id, note] of notes) this.notes.set(id, note);
  }

  private async readRecord<K extends RecordKind>(
    kind: K,
    id: string,
  ): Promise<MemoryRecords[K] | undefined> {
    return (await this.requireDb().getAsync(`${RECORD_PREFIX[kind]}${id}`)) as
      | MemoryRecords[K]
      | undefined;
  }

  listAtoms(): readonly Atom[] {
    return [...this.atoms.values()];
  }
  listNotes(): readonly NoteRecord[] {
    return [...this.notes.values()];
  }
  listConcepts(): readonly Concept[] {
    return [...this.derived.concept.values()];
  }
  listEdges(): readonly Edge[] {
    return [...this.derived.edge.values()];
  }
  listCooccurrences(): readonly Cooccurrence[] {
    return [...this.derived.cooc.values()];
  }
  listProcedures(): readonly Procedure[] {
    return [...this.derived.procedure.values()];
  }

  getAtom(id: string): Atom | undefined {
    const stored =
      this.atoms.get(id) ??
      (this.requireDb().get(`${RECORD_PREFIX.atom}${id}`) as StoredAtom | undefined);
    return stored === undefined ? undefined : unpackAtom(stored, this.getNote(stored.noteId));
  }
  getNote(id: string): NoteRecord | undefined {
    const note =
      this.notes.get(id) ??
      (this.requireDb().get(`${RECORD_PREFIX.note}${id}`) as NoteRecord | undefined);
    return note === undefined ? undefined : unpackNote(note);
  }
  getConcept(id: string): Concept | undefined {
    return (
      this.derived.concept.get(id) ??
      (this.requireDb().get(`${RECORD_PREFIX.concept}${id}`) as Concept | undefined)
    );
  }
  getEdge(id: string): Edge | undefined {
    return (
      this.derived.edge.get(id) ??
      (this.requireDb().get(`${RECORD_PREFIX.edge}${id}`) as Edge | undefined)
    );
  }
  getCooccurrence(key: string): Cooccurrence | undefined {
    return (
      this.derived.cooc.get(key) ??
      (this.requireDb().get(`${RECORD_PREFIX.cooc}${key}`) as Cooccurrence | undefined)
    );
  }
  getProcedure(id: string): Procedure | undefined {
    return (
      this.derived.procedure.get(id) ??
      (this.requireDb().get(`${RECORD_PREFIX.procedure}${id}`) as Procedure | undefined)
    );
  }

  async getNoteById(id: string): Promise<NoteRecord | undefined> {
    const note = this.notes.get(id) ?? (await this.readRecord('note', id));
    return note === undefined ? undefined : unpackNote(note);
  }
  async getAtomById(id: string): Promise<Atom | undefined> {
    const stored = this.atoms.get(id) ?? (await this.readRecord('atom', id));
    return stored === undefined
      ? undefined
      : unpackAtom(stored, await this.getNoteById(stored.noteId));
  }
  async findNoteByFingerprint(fingerprint: string, text: string): Promise<NoteRecord | undefined> {
    const expected = noteTerms(text).join('\0');
    const prefix = `${FINGERPRINT_PREFIX}${fingerprint}:`;
    for await (const page of pages(this.requireDb(), prefix)) {
      for (const row of page) {
        const id = row.key.slice(prefix.length);
        const note = await this.getNoteById(id);
        if (note !== undefined && noteTerms(note.text).join('\0') === expected) return note;
      }
    }
    return undefined;
  }

  counts(): Readonly<MemoryCounts> {
    return this.hotIndex.counts;
  }
  residentCounts(): {
    valueMode: string;
    atoms: number;
    notes: number;
    concepts: number;
    edges: number;
    cooccurrences: number;
    procedures: number;
    pinnedAtoms: number;
    referencedNotes: number;
  } {
    return {
      valueMode: this.requireDb().valueMode,
      atoms: this.atoms.size,
      notes: this.notes.size,
      concepts: this.derived.concept.size,
      edges: this.derived.edge.size,
      cooccurrences: this.derived.cooc.size,
      procedures: this.derived.procedure.size,
      pinnedAtoms: this.listAtoms().filter((atom) => atom.pinned).length,
      referencedNotes:
        this.notes.size - this.hotIndex.recentNotes.filter((id) => this.notes.has(id)).length,
    };
  }

  private indexEdges(): void {
    this.bySource.clear();
    for (const edge of this.derived.edge.values()) {
      let ids = this.bySource.get(edge.from);
      if (ids === undefined) {
        ids = new Set();
        this.bySource.set(edge.from, ids);
      }
      ids.add(edge.id);
    }
  }
  edgesFrom(sources: ReadonlySet<string>): readonly Edge[] {
    const out: Edge[] = [];
    for (const source of sources)
      for (const id of this.bySource.get(source) ?? []) {
        const edge = this.derived.edge.get(id);
        if (edge !== undefined) out.push(edge);
      }
    return out;
  }

  private mutate<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(task, task);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  private async commit(
    ops: readonly BatchInputOp[],
    index: HotIndex,
    publish: () => void,
  ): Promise<void> {
    await this.requireDb().batch([...ops, { op: 'set', key: HOT_INDEX_KEY, value: index }]);
    this.hotIndex = index;
    publish();
  }

  putNote(note: NoteRecord): Promise<void> {
    return this.mutate(async () => {
      const old = await this.getNoteById(note.id);
      const counts = copyCounts(this.hotIndex.counts);
      if (old !== undefined) countRecord(counts, 'note', old, -1);
      countRecord(counts, 'note', note, 1);
      const recentNotes = distinct([note.id, ...this.hotIndex.recentNotes]).slice(
        0,
        this.noteLimit,
      );
      const notes = await this.readNotes(this.requiredNoteIds(recentNotes), note);
      const index = {
        ...this.hotIndex,
        recentNotes,
        ids: { ...this.hotIndex.ids, note: [...notes.keys()] },
        counts,
      };
      const fingerprint = noteFingerprint(note.text);
      const ops: BatchInputOp[] = [
        { op: 'set', key: `${RECORD_PREFIX.note}${note.id}`, value: note },
        { op: 'set', key: `${FINGERPRINT_PREFIX}${fingerprint}:${note.id}`, value: true },
      ];
      if (old !== undefined && noteFingerprint(old.text) !== fingerprint) {
        ops.push({ op: 'del', key: `${FINGERPRINT_PREFIX}${noteFingerprint(old.text)}:${old.id}` });
        const legacyKey = `${FINGERPRINT_PREFIX}${noteFingerprint(old.text)}`;
        if ((await this.requireDb().getAsync(legacyKey)) === note.id)
          ops.push({ op: 'del', key: legacyKey });
      }
      await this.commit(ops, index, () => this.publishNotes(notes));
    });
  }

  async putAtom(atom: Atom): Promise<void> {
    await this.putAtoms([atom], atom.lastActivatedAt);
  }

  putAtoms(
    incoming: readonly Atom[],
    now: number,
    trainedEdges: readonly Edge[] = [],
  ): Promise<readonly string[]> {
    if (incoming.length === 0) return Promise.resolve([]);
    return this.mutate(async () => {
      const counts = copyCounts(this.hotIndex.counts);
      const atoms = new Map(this.atoms);
      const updates = new Map(incoming.map((atom) => [atom.id, atom]));
      for (const atom of updates.values()) {
        const previous = this.atoms.get(atom.id) ?? (await this.readRecord('atom', atom.id));
        if (previous?.isDeleted && !atom.isDeleted) {
          updates.delete(atom.id);
          continue;
        }
        if (previous !== undefined) countRecord(counts, 'atom', previous, -1);
        countRecord(counts, 'atom', atom, 1);
        if (atom.isDeleted || (!atom.pinned && !isWorkingAtom(atom))) atoms.delete(atom.id);
        else atoms.set(atom.id, atom);
      }
      const ordinary = [...atoms.values()].filter((atom) => !atom.pinned);
      const excess = Math.max(0, ordinary.length - this.atomLimit);
      const evicted: string[] = [];
      if (excess > 0) {
        const incident = new Map(this.derived.edge);
        for (const edge of trainedEdges) incident.set(edge.id, edge);
        const weights = new Map<string, number>();
        for (const edge of incident.values()) {
          if (edge.validUntil !== undefined) continue;
          weights.set(edge.from, (weights.get(edge.from) ?? 0) + edge.weight);
          if (edge.to !== edge.from)
            weights.set(edge.to, (weights.get(edge.to) ?? 0) + edge.weight);
        }
        const ranked = ordinary.map((atom) => ({
          atom,
          score: accessibilityFromWeight(
            atom,
            weights.get(atom.id) ?? 0,
            now,
            ASSOCIATIVE_MEMORY_PARAMS,
          ),
        }));
        ranked.sort((a, b) => a.score - b.score || compareByText(a.atom, b.atom));
        for (const { atom } of ranked.slice(0, excess)) {
          const cold = { ...atom, suppressed: true, validUntil: now };
          countRecord(counts, 'atom', atom, -1);
          countRecord(counts, 'atom', cold, 1);
          updates.set(atom.id, cold);
          atoms.delete(atom.id);
          evicted.push(atom.id);
        }
      }
      const ops: BatchInputOp[] = [];
      for (const atom of updates.values()) {
        const note = await this.getNoteById(atom.noteId);
        ops.push({
          op: 'set',
          key: `${RECORD_PREFIX.atom}${atom.id}`,
          value: packAtom(atom, note),
        });
      }
      const removed = new Set([...this.atoms.keys()].filter((id) => !atoms.has(id)));
      const ids = { ...this.hotIds(), atom: [...atoms.keys()] };
      ids.concept = ids.concept.filter((id) => {
        const value = this.derived.concept.get(id)!;
        return value.pinned || !value.atomIds.some((item) => removed.has(item));
      });
      ids.procedure = ids.procedure.filter((id) => {
        const value = this.derived.procedure.get(id)!;
        return value.pinned || !value.stepIds.some((item) => removed.has(item));
      });
      const removedNodes = new Set([
        ...removed,
        ...this.hotIndex.ids.concept.filter((id) => !ids.concept.includes(id)),
        ...this.hotIndex.ids.procedure.filter((id) => !ids.procedure.includes(id)),
      ]);
      ids.edge = ids.edge.filter((id) => {
        const value = this.derived.edge.get(id)!;
        return !removedNodes.has(value.from) && !removedNodes.has(value.to);
      });
      ids.cooc = ids.cooc.filter((id) => {
        const value = this.derived.cooc.get(id)!;
        return !removed.has(value.a) && !removed.has(value.b);
      });
      const procedures = new Map(
        [...this.derived.procedure].filter(([id]) => ids.procedure.includes(id)),
      );
      const referencedNotes = this.hotIndex.recentNotes;
      const notes = await this.readNotes(this.requiredNoteIds(referencedNotes, atoms, procedures));
      const nextRecent = referencedNotes.filter((id) => notes.has(id));
      ids.note = [...notes.keys()];
      await this.commit(ops, { ...this.hotIndex, ids, recentNotes: nextRecent, counts }, () => {
        this.atoms.clear();
        for (const [id, value] of atoms) this.atoms.set(id, value);
        for (const kind of DERIVED_KINDS) {
          const keep = new Set(ids[kind]);
          for (const id of this.derived[kind].keys())
            if (!keep.has(id)) this.derived[kind].delete(id);
        }
        this.publishNotes(notes);
        this.indexEdges();
      });
      return evicted;
    });
  }

  private putDerived<K extends DerivedKind>(kind: K, record: MemoryRecords[K]): Promise<void> {
    return this.mutate(async () => {
      const id = recordId(record);
      if ((await this.requireDb().getAsync(`forgotten:${kind}:${id}`)) === true) return;
      const old = await this.readRecord(kind, id);
      const counts = copyCounts(this.hotIndex.counts);
      if (old !== undefined) countRecord(counts, kind, old, -1);
      countRecord(counts, kind, record, 1);
      const map = new Map(this.derived[kind] as Map<string, MemoryRecords[K]>);
      map.delete(id);
      if (this.eligible(kind, record)) map.set(id, record);
      while (map.size > HOT_GRAPH_LIMIT) {
        const victim = [...map].find(([, value]) => !('pinned' in value && value.pinned));
        if (victim === undefined) break;
        map.delete(victim[0]);
      }
      const ids = { ...this.hotIds(), [kind]: [...map.keys()] };
      const procedures =
        kind === 'procedure' ? (map as Map<string, Procedure>) : this.derived.procedure;
      const notes = await this.readNotes(
        this.requiredNoteIds(this.hotIndex.recentNotes, this.atoms, procedures),
      );
      ids.note = [...notes.keys()];
      await this.commit(
        [{ op: 'set', key: `${RECORD_PREFIX[kind]}${id}`, value: record }],
        { ...this.hotIndex, ids, counts },
        () => {
          const target = this.derived[kind] as Map<string, MemoryRecords[K]>;
          target.clear();
          for (const [key, value] of map) target.set(key, value);
          this.publishNotes(notes);
          if (kind === 'edge') this.indexEdges();
        },
      );
    });
  }

  putConcept(record: Concept): Promise<void> {
    return this.putDerived('concept', record);
  }
  putEdge(record: Edge): Promise<void> {
    return this.putDerived('edge', record);
  }
  putCooccurrence(record: Cooccurrence): Promise<void> {
    return this.putDerived('cooc', record);
  }
  putProcedure(record: Procedure): Promise<void> {
    return this.putDerived('procedure', record);
  }

  private deleteRecord(kind: RecordKind, id: string, forgotten = false): Promise<void> {
    return this.mutate(async () => {
      const old = await this.readRecord(kind, id);
      if (old === undefined) return;
      const counts = copyCounts(this.hotIndex.counts);
      countRecord(counts, kind, old, -1);
      const ids = { ...this.hotIds(), [kind]: this.hotIndex.ids[kind].filter((key) => key !== id) };
      const recentNotes =
        kind === 'note'
          ? this.hotIndex.recentNotes.filter((key) => key !== id)
          : this.hotIndex.recentNotes;
      const ops: BatchInputOp[] = [{ op: 'del', key: `${RECORD_PREFIX[kind]}${id}` }];
      if (forgotten) ops.push({ op: 'set', key: `forgotten:${kind}:${id}`, value: true });
      if (kind === 'note') {
        const fingerprintKey = `${FINGERPRINT_PREFIX}${noteFingerprint((old as NoteRecord).text)}:${id}`;
        ops.push({ op: 'del', key: fingerprintKey });
      }
      await this.commit(ops, { ...this.hotIndex, ids, recentNotes, counts }, () => {
        if (kind === 'atom') this.atoms.delete(id);
        else if (kind === 'note') this.notes.delete(id);
        else this.derived[kind].delete(id);
        if (kind === 'edge') this.indexEdges();
      });
    });
  }
  deleteAtom(id: string): Promise<void> {
    return this.deleteRecord('atom', id);
  }
  deleteNote(id: string): Promise<void> {
    return this.deleteRecord('note', id);
  }
  deleteConcept(id: string, forgotten = false): Promise<void> {
    return this.deleteRecord('concept', id, forgotten);
  }
  deleteEdge(id: string): Promise<void> {
    return this.deleteRecord('edge', id);
  }
  deleteCooccurrence(id: string): Promise<void> {
    return this.deleteRecord('cooc', id);
  }
  deleteProcedure(id: string, forgotten = false): Promise<void> {
    return this.deleteRecord('procedure', id, forgotten);
  }

  trimNotes(): Promise<void> {
    return this.mutate(async () => {
      const recentNotes = this.hotIndex.recentNotes.slice(0, this.noteLimit);
      const notes = await this.readNotes(this.requiredNoteIds(recentNotes));
      const index = {
        ...this.hotIndex,
        recentNotes,
        ids: { ...this.hotIds(), note: [...notes.keys()] },
      };
      await this.commit([], index, () => this.publishNotes(notes));
    });
  }

  async clearDerived(): Promise<void> {
    for (const kind of DERIVED_KINDS) {
      for await (const page of this.recordPages(kind)) {
        for (const record of page) await this.deleteRecord(kind, recordId(record));
      }
    }
  }
  async clearGraph(): Promise<void> {
    await this.clearDerived();
    for await (const page of this.recordPages('atom'))
      for (const atom of page) await this.deleteAtom(atom.id);
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
  getMigration(originKey: string): LegacyMigrationRecord | undefined {
    return this.requireDb().get(`migration:${originKey}`) as LegacyMigrationRecord | undefined;
  }
  putMigration(originKey: string, record: LegacyMigrationRecord): Promise<void> {
    return this.mutate(async () => {
      await this.requireDb().set(`migration:${originKey}`, record);
    });
  }
  async close(): Promise<void> {
    await this.queue;
    await this.mutations;
    await this.db?.close();
    this.db = undefined;
    this.atoms.clear();
    this.notes.clear();
    for (const kind of DERIVED_KINDS) this.derived[kind].clear();
    this.bySource.clear();
  }
  private requireDb(): MiniDb {
    if (this.db === undefined) throw new Error('associative memory store is closed');
    return this.db;
  }
}
