import { join } from 'pathe';
import { ulid } from 'ulid';
import { writeFile } from 'node:fs/promises';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { projectIdFromCwd } from '#/app/memory/memoryPaths';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { activate } from './activate';
import type { AuditEntry } from './audit';
import {
  appendAudit,
  auditPath,
  readAudit,
  type AuditKind,
} from './audit';
import { applyRecallRules, applyWriteRules, codeAllowsEmbeddings, orderConflictGroups } from './code';
import {
  createHttpEmbeddingsClient,
  resolveEmbeddingsOptions,
  type EmbeddingsClient,
} from './embeddings';
import { DEFAULT_CODE } from './code/defaults';
import { loadCodeFile } from './code/load';
import { clusterIncremental } from './cluster';
import { applyDecay, pruneEdges } from './decay';
import { encodeAtoms } from './encode';
import { distillProcedures } from './procedure';
import {
  approveProposal as approveProposalInStore,
  proposeRule as proposeRuleInStore,
} from './code/proposals';
import { ASSOCIATIVE_MEMORY_FLAG_ID } from './flag';
import { ASSOCIATIVE_MEMORY_PARAMS } from './params';
import { renderRecall } from './render';
import { AssociativeMemoryStore } from './store';
import type {
  AssociativeMemoryExport,
  AssociativeMemoryList,
  AssociativeMemoryStats,
  Atom,
  Cooccurrence,
  Edge,
  HardRule,
  ListOptions,
  MemoryCode,
  MemoryScopeSelector,
  NoteRecord,
  RecallQuery,
  RecallResult,
  RecallTraceNode,
  ReconsolidateResult,
  ReplayResult,
  WriteResult,
} from './types';
import { computeDf, cosine } from './vector';
import { hebbianConnect } from './train';

export interface IAssociativeMemoryService {
  readonly _serviceBrand: undefined;
  writeNote(text: string, scope?: MemoryScopeSelector): Promise<WriteResult>;
  recall(query: RecallQuery): Promise<RecallResult>;
  pin(id: string): Promise<void>;
  forget(id: string): Promise<void>;
  list(options: ListOptions): Promise<AssociativeMemoryList>;
  export(scope?: MemoryScopeSelector): Promise<AssociativeMemoryExport>;
  replay(limit?: number): Promise<ReplayResult>;
  reconsolidate(targetId: string | undefined, text: string): Promise<ReconsolidateResult>;
  audit(limit?: number): Promise<readonly AuditEntry[]>;
  proposeRule(rule: unknown): Promise<void>;
  approveProposal(index: number): Promise<HardRule>;
  labelConcept(id: string, label: string): Promise<void>;
  stats(scope?: MemoryScopeSelector): Promise<AssociativeMemoryStats>;
  rebuild(scope?: MemoryScopeSelector): Promise<void>;
  explain(query: RecallQuery): Promise<RecallTraceNode[]>;
  signalBlock(message: string): Promise<string>;
  codeBlock(): Promise<string>;
}

export const IAssociativeMemoryService =
  createDecorator<IAssociativeMemoryService>('associativeMemoryService');

const storeRootName = 'associative-memory';
const codeFileName = 'code.md';
const globalScopeKey = 'global';
const RECONSOLIDATE_THRESHOLD = 0.5;
const stores = new Map<string, Promise<AssociativeMemoryStore>>();

export class AssociativeMemoryService
  extends Disposable
  implements IAssociativeMemoryService
{
  declare readonly _serviceBrand: undefined;

  private code: MemoryCode = DEFAULT_CODE;
  private codeLoaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly rendered = new Set<string>();
  private embeddingsClient: EmbeddingsClient | undefined;
  private embeddingsResolved = false;
  private lastRecallIds: readonly string[] = [];

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
  ) {
    super();
    this.reminders.register('associative_memory_signal', ({ isNewTurn }) =>
      isNewTurn ? this.signalBlock(this.lastUserText()) : undefined,
    );
  }

  protected now(): number {
    return Date.now();
  }

  async writeNote(text: string, scope: MemoryScopeSelector = 'project'): Promise<WriteResult> {
    if (!this.enabled() || text.trim().length === 0) {
      return { noteId: '', atomIds: [], blockedByCode: false, scope };
    }
    const code = await this.ensureCode();
    const gate = applyWriteRules(text, code.rules);
    if (!gate.allowed) {
      await this.recordAudit('write_blocked', { scope, rules: gate.matches.map((rule) => rule.id) });
      return { noteId: '', atomIds: [], blockedByCode: true, scope };
    }
    const store = await this.ensureStore(scope === 'global' ? globalScopeKey : this.projectKey());
    const now = this.now();
    const scopeKey = store.scopeKey;
    const note: NoteRecord = {
      id: `note_${ulid()}`,
      scopeKey,
      text,
      atomIds: [],
      createdAt: now,
    };
    await store.putNote(note);
    const atomIds = await this.enqueue(() => this.trainNote(store, note));
    await this.recordAudit('write_allowed', { scope, noteId: note.id, atoms: atomIds.length });
    return { noteId: note.id, atomIds: [...atomIds], blockedByCode: false, scope };
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    if (!this.enabled()) return { items: [], trace: [] };
    const code = await this.ensureCode();
    const scoped = await this.storesFor(query.scope);
    let cueDense: readonly number[] | undefined;
    try {
      const embeddings = await this.ensureEmbeddings();
      if (embeddings !== undefined) cueDense = (await embeddings.embed([query.cue]))[0];
    } catch (error) {
      this.log.warn('associative memory cue embedding failed; using sparse matching', { error });
    }
    const result = activate(
      query,
      scoped.flatMap((store) => store.listAtoms()),
      scoped.flatMap((store) => store.listConcepts()),
      scoped.flatMap((store) => store.listEdges()),
      ASSOCIATIVE_MEMORY_PARAMS,
      this.now(),
      scoped.flatMap((store) => store.listProcedures()),
      cueDense,
    );
    const filtered = applyRecallRules(result.items, code.rules);
    const items = orderConflictGroups(filtered, code.rules);
    this.lastRecallIds = items.map((item) => item.id);
    if (filtered.length < result.items.length) {
      await this.recordAudit('recall_filtered', {
        removed: result.items.length - filtered.length,
      });
    }
    return { items, trace: result.trace };
  }

  async signalBlock(message: string): Promise<string> {
    if (!this.enabled() || message.trim().length === 0) return '';
    try {
      const result = await this.recall({
        cue: message,
        limit: ASSOCIATIVE_MEMORY_PARAMS.topK,
        maxTokens: ASSOCIATIVE_MEMORY_PARAMS.injectionMaxTokens,
        includeHistory: false,
        scope: 'all',
      });
      const fresh = result.items.filter((item) => !this.rendered.has(item.id));
      if (fresh.length === 0) return '';
      for (const item of fresh) this.rendered.add(item.id);
      return renderRecall(
        { items: fresh, trace: result.trace },
        ASSOCIATIVE_MEMORY_PARAMS.injectionMaxTokens,
      );
    } catch (error) {
      this.log.warn('associative memory signal block failed', { error });
      return '';
    }
  }

  async pin(id: string): Promise<void> {
    if (!this.enabled()) return;
    for (const store of await this.storesFor('all')) {
      const atom = store.getAtom(id);
      if (atom !== undefined) {
        await store.putAtom({ ...atom, pinned: true, baseWeight: atom.baseWeight + 1 });
        await this.recordAudit('pin', { id });
        return;
      }
    }
    for (const store of await this.storesFor('all')) {
      const procedure = store.getProcedure(id);
      if (procedure !== undefined) {
        await store.putProcedure({ ...procedure, pinned: true });
        await this.recordAudit('pin', { id });
        return;
      }
    }
    for (const store of await this.storesFor('all')) {
      const concept = store.getConcept(id);
      if (concept !== undefined) {
        await store.putConcept({ ...concept, pinned: true });
        await this.recordAudit('pin', { id });
        return;
      }
    }
  }

  async forget(id: string): Promise<void> {
    if (!this.enabled()) return;
    for (const store of await this.storesFor('all')) {
      const atom = store.getAtom(id);
      if (atom !== undefined) {
        await store.putAtom({ ...atom, isDeleted: true, suppressed: true });
        await this.recordAudit('forget', { id });
        return;
      }
    }
    for (const store of await this.storesFor('all')) {
      const procedure = store.getProcedure(id);
      if (procedure !== undefined) {
        await store.putProcedure({ ...procedure, suppressed: true });
        await this.recordAudit('forget', { id });
        return;
      }
    }
    for (const store of await this.storesFor('all')) {
      const concept = store.getConcept(id);
      if (concept !== undefined) {
        await store.putConcept({ ...concept, suppressed: true });
        await this.recordAudit('forget', { id });
        return;
      }
    }
  }

  async stats(scope: MemoryScopeSelector = 'all'): Promise<AssociativeMemoryStats> {
    if (!this.enabled()) {
      return { atoms: 0, concepts: 0, procedures: 0, edges: 0, notes: 0, suppressed: 0, pinned: 0 };
    }
    const scoped = await this.storesFor(scope);
    const atoms = scoped.flatMap((store) => store.listAtoms());
    const concepts = scoped.flatMap((store) => store.listConcepts());
    return {
      atoms: atoms.length,
      concepts: concepts.length,
      edges: scoped.reduce((sum, store) => sum + store.listEdges().length, 0),
      notes: scoped.reduce((sum, store) => sum + store.listNotes().length, 0),
      procedures: scoped.reduce((sum, store) => sum + store.listProcedures().length, 0),
      suppressed:
        atoms.filter((atom) => atom.suppressed).length +
        concepts.filter((concept) => concept.suppressed).length,
      pinned:
        atoms.filter((atom) => atom.pinned).length +
        concepts.filter((concept) => concept.pinned).length,
    };
  }

  async list(options: ListOptions): Promise<AssociativeMemoryList> {
    if (!this.enabled()) return { atoms: [], concepts: [], procedures: [] };
    const scoped = await this.storesFor(options.scope);
    const limit = options.limit ?? ASSOCIATIVE_MEMORY_PARAMS.listLimit;
    const atoms =
      options.kind === 'concept' || options.kind === 'procedure'
        ? []
        : scoped
            .flatMap((store) => store.listAtoms())
            .filter((atom) => !atom.isDeleted)
            .toSorted((a, b) => b.lastActivatedAt - a.lastActivatedAt)
            .slice(0, limit);
    const concepts =
      options.kind === 'atom' || options.kind === 'procedure'
        ? []
        : scoped
            .flatMap((store) => store.listConcepts())
            .toSorted((a, b) => b.lastActivatedAt - a.lastActivatedAt)
            .slice(0, limit);
    const procedures =
      options.kind === 'atom' || options.kind === 'concept'
        ? []
        : scoped
            .flatMap((store) => store.listProcedures())
            .toSorted((a, b) => b.lastActivatedAt - a.lastActivatedAt)
            .slice(0, limit);
    return { atoms, concepts, procedures };
  }

  async export(scope: MemoryScopeSelector = 'all'): Promise<AssociativeMemoryExport> {
    if (!this.enabled()) return { path: '', atoms: 0, concepts: 0, notes: 0 };
    const scoped = await this.storesFor(scope);
    const atoms = scoped.flatMap((store) => store.listAtoms());
    const concepts = scoped.flatMap((store) => store.listConcepts());
    const notes = scoped.flatMap((store) => store.listNotes());
    const edges = scoped.flatMap((store) => store.listEdges());
    const procedures = scoped.flatMap((store) => store.listProcedures());
    const audit = await this.audit(200);
    const path = join(this.bootstrap.cwd, 'memory-export.json');
    await writeFile(
      path,
      `${JSON.stringify({
        exportedAt: new Date(this.now()).toISOString(),
        atoms,
        concepts,
        procedures,
        edges,
        notes,
        audit,
      })}\n`,
      'utf8',
    );
    return { path, atoms: atoms.length, concepts: concepts.length, notes: notes.length };
  }

  async replay(limit = 10): Promise<ReplayResult> {
    if (!this.enabled()) return { replayed: 0 };
    const store = await this.ensureStore(this.projectKey());
    const candidates = store
      .listAtoms()
      .filter((atom) => atom.replayPriority > 0)
      .toSorted(
        (a, b) => b.replayPriority - a.replayPriority || (a.id < b.id ? -1 : 1),
      )
      .slice(0, limit);
    if (candidates.length === 0) return { replayed: 0 };
    const now = this.now();
    const selected = new Map(candidates.map((atom) => [atom.id, atom]));
    const edges = store.listEdges();
    const neighbors = new Map<string, readonly Atom[]>();
    for (const edge of edges) {
      if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
      neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), selected.get(edge.to)!]);
    }
    for (const atom of candidates) {
      const related = neighbors.get(atom.id) ?? [];
      if (related.length === 0) continue;
      const trained = hebbianConnect(
        [atom],
        related,
        edges,
        ASSOCIATIVE_MEMORY_PARAMS,
        new Map(),
        now,
      );
      for (const edge of trained.edges) await store.putEdge(edge);
    }
    for (const atom of candidates) {
      await store.putAtom({
        ...atom,
        replayPriority: Math.max(0, atom.replayPriority - 1),
        lastActivatedAt: now,
      });
    }
    await this.recordAudit('replay', { replayed: candidates.length });
    return { replayed: candidates.length };
  }

  async proposeRule(rule: unknown): Promise<void> {
    if (!this.enabled()) return;
    await proposeRuleInStore(this.bootstrap.homeDir, storeRootName, rule);
    await this.recordAudit('code_proposed');
  }

  async approveProposal(index: number): Promise<HardRule> {
    if (!this.enabled()) throw new Error('associative memory is disabled');
    const rule = await approveProposalInStore(
      this.bootstrap.homeDir,
      storeRootName,
      index,
      DEFAULT_CODE,
    );
    this.codeLoaded = false;
    await this.ensureCode();
    await this.recordAudit('code_approved', { index, id: rule.id });
    return rule;
  }

  async labelConcept(id: string, label: string): Promise<void> {
    if (!this.enabled()) return;
    for (const store of await this.storesFor('all')) {
      const concept = store.getConcept(id);
      if (concept !== undefined) {
        await store.putConcept({ ...concept, label, labelSource: 'llm' });
        await this.recordAudit('label', { id });
        return;
      }
    }
  }

  async audit(limit = 20): Promise<readonly AuditEntry[]> {
    return readAudit(auditPath(this.bootstrap.storeDir, storeRootName), limit);
  }

  async reconsolidate(
    targetId: string | undefined,
    text: string,
  ): Promise<ReconsolidateResult> {
    if (!this.enabled() || text.trim().length === 0) {
      return { noteId: '', atomIds: [], superseded: false };
    }
    const code = await this.ensureCode();
    const gate = applyWriteRules(text, code.rules);
    if (!gate.allowed) {
      await this.recordAudit('write_blocked', { reason: gate.matches.map((rule) => rule.id) });
      return { noteId: '', atomIds: [], superseded: false };
    }
    const targetStore = await this.findAtomStore(targetId ?? this.lastRecallIds[0]);
    if (targetStore === undefined) {
      return { noteId: '', atomIds: [], superseded: false };
    }
    const store = targetStore.store;
    const target = targetStore.atom;
    const now = this.now();
    const atoms = store.listAtoms();
    const df = computeDf(atoms);
    const encoded = encodeAtoms(
      { id: `note_${ulid()}`, scopeKey: target.scopeKey, text },
      df,
      atoms.length,
      now,
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    let newAtoms = encoded;
    try {
      const embeddings = await this.ensureEmbeddings();
      if (embeddings !== undefined && newAtoms.length > 0) {
        const vectors = await embeddings.embed(newAtoms.map((atom) => atom.text));
        newAtoms = newAtoms.map((atom, index) => ({ ...atom, denseVector: vectors[index] }));
      }
    } catch (error) {
      this.log.warn('associative memory embeddings failed during reconsolidation', { error });
    }
    const neighbors = this.neighborsOf(store, target.id);
    const trained = hebbianConnect(
      newAtoms,
      [target, ...neighbors],
      store.listEdges(),
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      now,
      (candidate, existing) =>
        existing.id === target.id &&
        cosine(candidate.vector, existing.vector) > RECONSOLIDATE_THRESHOLD,
    );
    let superseded = false;
    for (const [id, state] of trained.superseded) {
      const old = store.getAtom(id);
      if (old !== undefined && !old.pinned) {
        await store.putAtom({ ...old, validUntil: state.validUntil, suppressed: state.suppressed });
        superseded = true;
        await this.recordAudit('supersede', { from: newAtoms[0]?.id, to: id });
      }
    }
    for (const atom of newAtoms) await store.putAtom(atom);
    for (const edge of trained.edges) await store.putEdge(edge);
    await store.putNote({
      id: `note_${ulid()}`,
      scopeKey: target.scopeKey,
      text,
      atomIds: newAtoms.map((atom) => atom.id),
      createdAt: now,
    });
    await this.maintain(store, now);
    await this.recordAudit('reconsolidate', { targetId: target.id, newAtomIds: newAtoms.map((atom) => atom.id) });
    return { noteId: newAtoms[0]?.noteId ?? '', atomIds: newAtoms.map((atom) => atom.id), superseded };
  }

  private async findAtomStore(
    id: string | undefined,
  ): Promise<{ readonly store: AssociativeMemoryStore; readonly atom: Atom } | undefined> {
    if (id === undefined) return undefined;
    for (const store of await this.storesFor('all')) {
      const atom = store.getAtom(id);
      if (atom !== undefined) return { store, atom };
    }
    return undefined;
  }

  private neighborsOf(store: AssociativeMemoryStore, id: string): readonly Atom[] {
    const neighbors: Atom[] = [];
    for (const edge of store.listEdges()) {
      if (edge.from !== id) continue;
      const target = store.getAtom(edge.to);
      if (target !== undefined) neighbors.push(target);
    }
    return neighbors;
  }

  private async recordAudit(
    kind: AuditKind,
    detail: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    try {
      await appendAudit(auditPath(this.bootstrap.storeDir, storeRootName), {
        at: this.now(),
        kind,
        detail,
      });
    } catch (error) {
      this.log.warn('associative memory audit write failed', { error });
    }
  }

  async explain(query: RecallQuery): Promise<RecallTraceNode[]> {
    const result = await this.recall(query);
    return [...result.trace];
  }

  async codeBlock(): Promise<string> {
    if (!this.enabled()) return '';
    const code = await this.ensureCode();
    return code.guidance;
  }

  async rebuild(scope: MemoryScopeSelector = 'all'): Promise<void> {
    if (!this.enabled()) return;
    for (const store of await this.storesFor(scope)) {
      const notes = store.listNotes();
      await store.clearGraph();
      for (const note of notes) {
        await this.trainNote(store, note);
      }
    }
    await this.recordAudit('rebuild', { scope });
  }

  private async trainNote(
    store: AssociativeMemoryStore,
    note: NoteRecord,
  ): Promise<readonly string[]> {
    const now = this.now();
    const atoms = store.listAtoms();
    const df = computeDf(atoms);
    let newAtoms = encodeAtoms(note, df, atoms.length, now, ASSOCIATIVE_MEMORY_PARAMS);
    try {
      const embeddings = await this.ensureEmbeddings();
      if (embeddings !== undefined && newAtoms.length > 0) {
        const vectors = await embeddings.embed(newAtoms.map((atom) => atom.text));
        newAtoms = newAtoms.map((atom, index) => ({ ...atom, denseVector: vectors[index] }));
      }
    } catch (error) {
      this.log.warn('associative memory embeddings failed; storing sparse vectors only', { error });
    }
    const context = [
      ...atoms.filter(
        (atom) => now - atom.lastActivatedAt <= ASSOCIATIVE_MEMORY_PARAMS.contextWindowMs,
      ),
      ...newAtoms,
    ];
    const trained = hebbianConnect(
      newAtoms,
      context,
      store.listEdges(),
      ASSOCIATIVE_MEMORY_PARAMS,
      new Map(),
      now,
    );
    for (const [id, state] of trained.superseded) {
      const old = store.getAtom(id);
      if (old !== undefined && !old.pinned) {
        await store.putAtom({
          ...old,
          validUntil: state.validUntil,
          suppressed: state.suppressed,
          replayPriority: old.replayPriority + 1,
        });
        await this.recordAudit('supersede', { from: note.id, to: id });
      }
    }
    for (const atom of newAtoms) await store.putAtom(atom);
    for (const edge of trained.edges) await store.putEdge(edge);
    const coocs = await this.updateCooccurrence(store, newAtoms, context);
    const cluster = clusterIncremental(
      store.listAtoms(),
      coocs,
      store.listConcepts(),
      ASSOCIATIVE_MEMORY_PARAMS,
      now,
    );
    for (const concept of cluster.concepts) await store.putConcept(concept);
    for (const edge of cluster.edges) await store.putEdge(edge);
    const procedures = distillProcedures(
      store.listNotes(),
      store.listAtoms(),
      store.listProcedures(),
      ASSOCIATIVE_MEMORY_PARAMS,
      now,
    );
    for (const procedure of procedures.procedures) await store.putProcedure(procedure);
    for (const edge of procedures.edges) await store.putEdge(edge);
    const atomIds = newAtoms.map((atom) => atom.id);
    await store.putNote({ ...note, atomIds });
    await this.maintain(store, now);
    return atomIds;
  }

  private async maintain(store: AssociativeMemoryStore, now: number): Promise<void> {
    const pinned = new Set<string>();
    for (const atom of store.listAtoms()) if (atom.pinned) pinned.add(atom.id);
    for (const concept of store.listConcepts()) if (concept.pinned) pinned.add(concept.id);
    const edges = store.listEdges();
    const kept = new Map<string, Edge>();
    for (const edge of pruneEdges(
      applyDecay(
        edges,
        now,
        ASSOCIATIVE_MEMORY_PARAMS,
        pinned,
        0.5 + ASSOCIATIVE_MEMORY_PARAMS.conceptFormationRate,
      ),
      ASSOCIATIVE_MEMORY_PARAMS,
    )) {
      kept.set(edge.id, edge);
    }
    for (const edge of edges) {
      const next = kept.get(edge.id);
      if (next === undefined) await store.deleteEdge(edge.id);
      else if (next !== edge) await store.putEdge(next);
    }
  }

  private async updateCooccurrence(
    store: AssociativeMemoryStore,
    newAtoms: readonly Atom[],
    context: readonly Atom[],
  ): Promise<readonly Cooccurrence[]> {
    const byKey = new Map(store.listCooccurrences().map((cooc) => [cooc.key, cooc]));
    const now = this.now();
    for (const a of newAtoms) {
      for (const b of context) {
        if (a.id === b.id) continue;
        const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        const key = `${x}|${y}`;
        const previous = byKey.get(key);
        const next: Cooccurrence =
          previous === undefined
            ? { key, a: x, b: y, count: 1, lastAt: now }
            : { ...previous, count: previous.count + 1, lastAt: now };
        byKey.set(key, next);
        await store.putCooccurrence(next);
      }
    }
    return [...byKey.values()];
  }

  private async ensureStore(scopeKey: string): Promise<AssociativeMemoryStore> {
    const key = join(this.bootstrap.storeDir, storeRootName, scopeKey);
    let pending = stores.get(key);
    if (pending === undefined) {
      pending = AssociativeMemoryStore.open(
        scopeKey,
        join(this.bootstrap.storeDir, storeRootName),
      );
      stores.set(key, pending);
      pending.catch(() => {
        if (stores.get(key) === pending) stores.delete(key);
      });
    }
    return pending;
  }

  private async storesFor(
    scope: MemoryScopeSelector | undefined,
  ): Promise<readonly AssociativeMemoryStore[]> {
    if (scope === 'global') return [await this.ensureStore(globalScopeKey)];
    if (scope === 'project') return [await this.ensureStore(this.projectKey())];
    return [await this.ensureStore(this.projectKey()), await this.ensureStore(globalScopeKey)];
  }

  private async ensureEmbeddings(): Promise<EmbeddingsClient | undefined> {
    if (this.embeddingsResolved) return this.embeddingsClient;
    this.embeddingsResolved = true;
    const code = await this.ensureCode();
    if (!codeAllowsEmbeddings(code)) {
      await this.recordAudit('embeddings_blocked');
      return undefined;
    }
    const options = resolveEmbeddingsOptions(this.bootstrap);
    if (options === undefined) return undefined;
    this.embeddingsClient = createHttpEmbeddingsClient(options);
    return this.embeddingsClient;
  }

  private async ensureCode(): Promise<MemoryCode> {
    if (this.codeLoaded) return this.code;
    this.code = await loadCodeFile(
      join(this.bootstrap.homeDir, storeRootName, codeFileName),
      DEFAULT_CODE,
    );
    this.codeLoaded = true;
    return this.code;
  }

  private projectKey(): string {
    return projectIdFromCwd(this.bootstrap.cwd);
  }

  private enabled(): boolean {
    try {
      return this.flags.enabled(ASSOCIATIVE_MEMORY_FLAG_ID);
    } catch {
      return false;
    }
  }

  private lastUserText(): string {
    const history = this.contextMemory.get();
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message?.role !== 'user') continue;
      for (const part of message.content ?? []) {
        if ('text' in part && part.text) return part.text;
      }
    }
    return '';
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAssociativeMemoryService,
  AssociativeMemoryService,
  ScopeActivation.OnScopeCreated,
  'associativeMemory',
);
