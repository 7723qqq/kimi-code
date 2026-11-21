import { open } from 'node:fs/promises';

import { join } from 'pathe';
import { ulid } from 'ulid';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentMemoryInjectionState } from '#/agent/injection/memoryInjectionState';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { legacyProjectIdFromCwd, projectIdFromCwd } from '#/app/memory/memoryPaths';
import type { MemoryEntry } from '#/app/memory/memoryPaths';
import { IMemoryStore } from '#/app/memory/memoryStore';
import { createMemoryVisibilityContext } from '#/app/memory/memoryVisibility';
import { LifecycleScope } from '#/app/scopes';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { accessibility } from './accessibility';
import { activate } from './activate';
import { recentActivity } from './activity';
import type { AuditEntry } from './audit';
import { appendAudit, auditPath, readAudit, type AuditKind } from './audit';
import { clusterIncremental, coocClusterThreshold } from './cluster';
import {
  applyWriteRules,
  codeAllowsEmbeddings,
  filterRecallItems,
  orderConflictGroups,
} from './code';
import { DEFAULT_CODE } from './code/defaults';
import { loadCodeFile } from './code/load';
import {
  approveProposal as approveProposalInStore,
  proposeRule as proposeRuleInStore,
} from './code/proposals';
import {
  applyDecay,
  applyMotivatedForgetting,
  applySleepDownscale,
  pruneCooccurrences,
  pruneEdges,
  restoreCaptured,
} from './decay';
import { noteFingerprint } from './dedupe';
import {
  createHttpEmbeddingsClient,
  resolveEmbeddingsOptions,
  type EmbeddingsClient,
} from './embeddings';
import { encodeAtoms } from './encode';
import { ASSOCIATIVE_MEMORY_FLAG_ID } from './flag';
import { classifyGating } from './gating';
import { LegacyMemoryMigration, sessionMemoryScopeKey } from './legacyMemoryMigration';
import { updateConfidence } from './metacognition';
import { ASSOCIATIVE_MEMORY_PARAMS } from './params';
import { distillProcedures } from './procedure';
import { MEMORY_DATA_BOUNDARY, renderRecallWithItems } from './render';
import { interleave, rankByNeedGain } from './scheduler';
import { collectSchemaLinks } from './schema';
import { AssociativeMemoryStore } from './store';
import { compareByText } from './terms';
import { hebbianConnect, sharesContentTerm } from './train';
import type { LegacyMemoryOrigin } from './types';
import type {
  AssociativeMemoryExport,
  AssociativeMemoryList,
  AssociativeMemoryStats,
  Atom,
  Cooccurrence,
  Concept,
  Edge,
  Procedure,
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
  RecallDrop,
  RecallItem,
  MemorySource,
} from './types';
import { computeDf, cosine } from './vector';
import { WorkingBuffer } from './workingBuffer';

export interface IAssociativeMemoryService {
  readonly _serviceBrand: undefined;
  writeNote(text: string, scope?: MemoryScopeSelector, source?: MemorySource): Promise<WriteResult>;
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
  explain(query: RecallQuery): Promise<{
    readonly trace: readonly RecallTraceNode[];
    readonly dropped: readonly RecallDrop[];
  }>;
  signalBlock(message: string): Promise<string>;
  codeBlock(): Promise<string>;
}

export const IAssociativeMemoryService = createDecorator<IAssociativeMemoryService>(
  'associativeMemoryService',
);

const storeRootName = 'associative-memory';
const codeFileName = 'code.md';
const globalScopeKey = 'global';
const RECONSOLIDATE_THRESHOLD = 0.5;
const EMBEDDINGS_RETRY_MS = 60_000;
const MAINTAIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAINTAIN_EVERY_WRITES = 8;
const CONFIDENCE_RATE = 0.2;
const COOC_CONTEXT_LIMIT = 24;
const ACTIVATION_COOC_LIMIT = 8;
const AUDIT_ID_LIMIT = 50;
const CONSOLIDATION_POOL = 16;
const CONSOLIDATION_PAIR_BUDGET = 96;
const MAX_ATOMS = 4000;
const AUDIT_TEXT_LIMIT = 400;

function mostRecent(atoms: readonly Atom[], limit: number): readonly Atom[] {
  const kept: Atom[] = [];
  for (const atom of atoms) {
    let index = kept.length;
    while (index > 0) {
      const previous = kept[index - 1]!;
      const newer =
        atom.lastActivatedAt > previous.lastActivatedAt ||
        (atom.lastActivatedAt === previous.lastActivatedAt && compareByText(atom, previous) < 0);
      if (!newer) break;
      index -= 1;
    }
    if (index >= limit) continue;
    kept.splice(index, 0, atom);
    if (kept.length > limit) kept.pop();
  }
  return kept;
}
const MAX_NOTES = 8000;
const stores = new Map<string, StoreHandle>();
interface StoreHandle {
  readonly pending: Promise<AssociativeMemoryStore>;
  refs: number;
  closing?: Promise<void>;
}

function acquireStore(key: string, open: () => Promise<AssociativeMemoryStore>): StoreHandle {
  let handle = stores.get(key);
  if (handle === undefined || handle.closing !== undefined) {
    const previous = handle?.closing;
    const next = { pending: previous === undefined ? open() : previous.then(open), refs: 0 };
    stores.set(key, next);
    void next.pending.catch(() => {
      if (stores.get(key) === next) stores.delete(key);
    });
    handle = next;
  }
  handle.refs += 1;
  return handle;
}

function releaseStore(key: string, handle: StoreHandle): Promise<void> {
  if (handle.closing !== undefined) return handle.closing;
  handle.refs -= 1;
  if (handle.refs > 0) return Promise.resolve();
  handle.closing = handle.pending
    .then((store) => store.close())
    .finally(() => {
      if (stores.get(key) === handle) stores.delete(key);
    });
  return handle.closing;
}

export class AssociativeMemoryService extends Disposable implements IAssociativeMemoryService {
  declare readonly _serviceBrand: undefined;

  private code: MemoryCode = DEFAULT_CODE;
  private codeLoaded = false;
  private codeMtimeMs = 0;
  private migratedProjectScope = false;
  private legacyMemoryMigration: LegacyMemoryMigration | undefined;
  private embeddingsClient: EmbeddingsClient | undefined;
  private embeddingsResolved = false;
  private embeddingsResolvedAt = 0;
  private embeddingsBlockedLogged = false;
  private lastMaintainedAt = 0;
  private lastWriteText: string | undefined;
  private lastRecallCue: string | undefined;
  private lastGatingMode = 'retrieve';
  private writesSinceMaintain = 0;
  private readonly storeHandles = new Map<string, StoreHandle>();
  private lastRecallIds: readonly string[] = [];
  private previousRecallIds: readonly string[] = [];
  private readonly working = new WorkingBuffer(24, 6 * 60 * 60 * 1000);

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log: ILogService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
    @ISessionContext private readonly session: ISessionContext,
    @IMemoryStore private readonly memoryStore: IMemoryStore,
    @IAgentMemoryInjectionState private readonly injectionState: IAgentMemoryInjectionState,
  ) {
    super();
    this.reminders.register('associative_memory_signal', ({ isNewTurn }) => {
      if (!isNewTurn) return undefined;
      try {
        return this.signalBlock(this.lastUserText());
      } catch {
        return undefined;
      }
    });
    this._register(
      toDisposable(() => {
        void this.releaseStores().catch((error) =>
          this.log.warn('associative memory close failed', { error }),
        );
      }),
    );
  }

  protected now(): number {
    return Date.now();
  }

  private async importLegacyMemory(): Promise<void> {
    if (!this.enabled()) return;
    this.legacyMemoryMigration ??= new LegacyMemoryMigration({
      source: this.memoryStore,
      visibility: () =>
        createMemoryVisibilityContext(
          this.session.cwd || this.bootstrap.cwd,
          this.session.sessionId,
        ),
      openStore: async (key) => {
        if (key === this.projectKey()) await this.projectScopeKey();
        return this.ensureStore(key);
      },
      importEntry: (entry, store, noteId, origin) =>
        this.importLegacyEntry(entry, store, noteId, origin),
      retireNote: async (store, noteId) => {
        const ids = new Set(
          store
            .listAtoms()
            .filter((atom) => atom.noteId === noteId && !atom.pinned)
            .map((atom) => atom.id),
        );
        await this.retireAtoms(store, ids, this.now());
      },
      now: () => this.now(),
      log: this.log,
    });
    await this.legacyMemoryMigration.run();
  }

  private async importLegacyEntry(
    entry: MemoryEntry,
    store: AssociativeMemoryStore,
    noteId: string,
    origin: LegacyMemoryOrigin,
  ): Promise<void> {
    const code = await this.ensureCode();
    const gate = applyWriteRules(entry.body, code.rules);
    if (!gate.allowed) {
      await this.recordAudit('write_blocked', {
        scope: store.scopeKey,
        rules: gate.matches.map((rule) => rule.id),
      });
      throw new Error('Legacy memory is blocked by the current memory code');
    }
    const existing = await store.getNoteById(noteId);
    const note = existing ?? {
      id: noteId,
      scopeKey: store.scopeKey,
      text: entry.body,
      createdAt: entry.updatedAt,
      source: 'legacy' as const,
      legacyOrigin: origin,
    };
    if (existing === undefined) await store.putNote(note);
    await this.trainNote(store, note, existing !== undefined);
  }

  async writeNote(
    text: string,
    scope: MemoryScopeSelector = 'project',
    source: MemorySource = 'user',
  ): Promise<WriteResult> {
    if (!this.enabled() || text.trim().length === 0) {
      return { noteId: '', atomIds: [], blockedByCode: false, scope, decision: 'noop' };
    }
    await this.importLegacyMemory();
    const code = await this.ensureCode();
    const gate = applyWriteRules(text, code.rules);
    if (!gate.allowed) {
      const gating = classifyGating({
        sameCueRepeated: false,
        unstableRecall: false,
        newScopeOrTopic: false,
        positiveFeedback: false,
      });
      await this.recordAudit('write_blocked', {
        scope,
        rules: gate.matches.map((rule) => rule.id),
        gating: gating.mode,
      });
      return { noteId: '', atomIds: [], blockedByCode: true, scope, decision: 'blocked' };
    }
    const store = await this.ensureStore(
      scope === 'global' ? globalScopeKey : await this.projectScopeKey(),
    );
    return store.runExclusive(async () => {
      const now = this.now();
      const scopeKey = store.scopeKey;
      const gating = classifyGating({
        sameCueRepeated:
          this.lastWriteText !== undefined &&
          noteFingerprint(this.lastWriteText) === noteFingerprint(text),
        unstableRecall: this.lastRecallIds.length === 0 && store.listNotes().length > 0,
        newScopeOrTopic: store.listNotes().length === 0,
        positiveFeedback: false,
      });
      this.lastWriteText = text;

      const candidate = await this.findMergeCandidate(store, text);
      if (candidate !== undefined) {
        await this.reinforceNote(store, candidate.note, now);
        await this.recordAudit('write_noop', {
          scope,
          noteId: candidate.note.id,
          discarded: text.slice(0, AUDIT_TEXT_LIMIT),
          gating: gating.mode,
        });
        return {
          noteId: candidate.note.id,
          atomIds: [],
          blockedByCode: false,
          scope,
          decision: 'noop',
        };
      }

      const note: NoteRecord = {
        id: `note_${ulid()}`,
        scopeKey,
        text,
        createdAt: now,
        source,
      };
      await store.putNote(note);
      const atomIds = await this.trainNote(store, note);
      await this.recordAudit('write_allowed', {
        scope,
        noteId: note.id,
        atoms: atomIds.length,
        gating: gating.mode,
      });
      return {
        noteId: note.id,
        atomIds: [...atomIds],
        blockedByCode: false,
        scope,
        decision: 'added',
      };
    });
  }

  private async recordActivationCooccurrence(
    stores: readonly AssociativeMemoryStore[],
    items: readonly RecallItem[],
    now: number,
  ): Promise<void> {
    const ids = items
      .filter((item) => item.kind === 'atom')
      .slice(0, ACTIVATION_COOC_LIMIT)
      .map((item) => item.id);
    if (ids.length < 2) return;
    for (const store of stores) {
      const owned = ids.filter((id) => store.getAtom(id) !== undefined);
      if (owned.length < 2) continue;
      const threshold = coocClusterThreshold(ASSOCIATIVE_MEMORY_PARAMS);
      let crossed = false;
      for (let left = 0; left < owned.length; left += 1) {
        for (let right = left + 1; right < owned.length; right += 1) {
          const first = owned[left]!;
          const second = owned[right]!;
          const [a, b] = first < second ? [first, second] : [second, first];
          const key = `${a}|${b}`;
          const previous = store.getCooccurrence(key);
          const next: Cooccurrence =
            previous === undefined
              ? { key, a, b, count: 1, lastAt: now }
              : { ...previous, count: previous.count + 1, lastAt: now };
          await store.putCooccurrence(next);
          if (next.count >= threshold && (previous?.count ?? 0) < threshold) crossed = true;
        }
      }
      if (!crossed) continue;
      const cluster = clusterIncremental(
        store.listAtoms(),
        store.listCooccurrences(),
        store.listConcepts(),
        ASSOCIATIVE_MEMORY_PARAMS,
        now,
      );
      for (const concept of cluster.concepts) await store.putConcept(concept);
      for (const edge of cluster.edges) await store.putEdge(edge);
    }
  }

  private async persistSchemaLinks(
    stores: readonly AssociativeMemoryStore[],
    trace: readonly RecallTraceNode[],
    now: number,
  ): Promise<void> {
    for (const link of collectSchemaLinks(trace, ASSOCIATIVE_MEMORY_PARAMS)) {
      const id = `${link.from}?${link.to}`;
      for (const store of stores) {
        if (store.getAtom(link.from) === undefined || store.getAtom(link.to) === undefined)
          continue;
        const existing = store.getEdge(id);
        await store.putEdge({
          id,
          from: link.from,
          to: link.to,
          kind: 'schema',
          weight: 1 / link.hops,
          strengthenCount: (existing?.strengthenCount ?? 0) + 1,
          validFrom: existing?.validFrom ?? now,
          validUntil: undefined,
          createdAt: existing?.createdAt ?? now,
          lastUsedAt: now,
        });
        break;
      }
    }
  }

  private async touchInjected(
    stores: readonly AssociativeMemoryStore[],
    items: readonly RecallItem[],
    now: number,
  ): Promise<void> {
    const ids = items
      .filter((item) => item.kind === 'atom')
      .slice(0, ACTIVATION_COOC_LIMIT)
      .map((item) => item.id);
    if (ids.length === 0) return;
    for (const store of stores) {
      for (const id of ids) {
        const atom = store.getAtom(id);
        if (atom === undefined) continue;
        await store.putAtom({ ...atom, lastActivatedAt: now });
      }
    }
  }

  private async reinforceRecalled(
    stores: readonly AssociativeMemoryStore[],
    items: readonly { readonly id: string }[],
    now: number,
  ): Promise<void> {
    const recalled = new Set(items.map((item) => item.id));
    if (recalled.size === 0) return;
    for (const store of stores) {
      for (const edge of store.listEdges()) {
        if (!recalled.has(edge.from) || !recalled.has(edge.to)) continue;
        const strengthenCount = edge.strengthenCount + 1;
        await store.putEdge({
          ...edge,
          weight: Math.min(
            ASSOCIATIVE_MEMORY_PARAMS.maxEdgeWeight,
            edge.weight + ASSOCIATIVE_MEMORY_PARAMS.baseLearningRate / strengthenCount,
          ),
          strengthenCount,
          lastUsedAt: now,
        });
      }
      for (const atom of store.listAtoms()) {
        if (!recalled.has(atom.id)) continue;
        await store.putAtom({ ...atom, lastActivatedAt: now });
      }
    }
  }

  private async findMergeCandidate(
    store: AssociativeMemoryStore,
    text: string,
  ): Promise<{ readonly note: NoteRecord } | undefined> {
    const note = await store.findNoteByFingerprint(noteFingerprint(text), text);
    if (note === undefined) return undefined;
    return { note };
  }

  private async reinforceNote(
    store: AssociativeMemoryStore,
    note: NoteRecord,
    now: number,
  ): Promise<void> {
    for (const atom of store.listAtoms()) {
      if (atom.noteId !== note.id) continue;
      await store.putAtom({ ...atom, lastActivatedAt: now });
    }
  }

  private async detachAtomLinks(
    store: AssociativeMemoryStore,
    doomed: ReadonlySet<string>,
  ): Promise<void> {
    if (doomed.size === 0) return;
    for (const edge of store.listEdges()) {
      if (doomed.has(edge.from) || doomed.has(edge.to)) await store.deleteEdge(edge.id);
    }
    for (const cooc of store.listCooccurrences()) {
      if (doomed.has(cooc.a) || doomed.has(cooc.b)) await store.deleteCooccurrence(cooc.key);
    }
    for (const procedure of store.listProcedures()) {
      if (procedure.stepIds.some((id) => doomed.has(id))) await store.deleteProcedure(procedure.id);
    }
    for (const concept of store.listConcepts()) {
      if (concept.atomIds.some((id) => doomed.has(id))) await store.deleteConcept(concept.id);
    }
  }

  private async retireAtoms(
    store: AssociativeMemoryStore,
    doomed: ReadonlySet<string>,
    now: number,
  ): Promise<void> {
    for (const id of doomed) {
      const atom = store.getAtom(id);
      if (atom === undefined) continue;
      await store.putAtom({ ...atom, suppressed: true, validUntil: now });
    }
  }

  private async forgetDerived(store: AssociativeMemoryStore, id: string): Promise<void> {
    for (const edge of store.listEdges()) {
      if (edge.from === id || edge.to === id) await store.deleteEdge(edge.id);
    }
    await store.deleteConcept(id, true);
    await store.deleteProcedure(id, true);
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    if (!this.enabled()) return { items: [], trace: [] };
    await this.importLegacyMemory();
    const code = await this.ensureCode();
    const scoped = await this.storesFor(query.scope);
    await this.maybeMaintain(scoped);
    const gating = classifyGating({
      sameCueRepeated: this.lastRecallCue === query.cue,
      unstableRecall:
        this.previousRecallIds.length > 0 &&
        (this.previousRecallIds.length !== this.lastRecallIds.length ||
          this.previousRecallIds.some((id, index) => id !== this.lastRecallIds[index])),
      newScopeOrTopic: false,
      positiveFeedback: false,
    });
    this.lastRecallCue = query.cue;
    this.lastGatingMode = gating.mode;
    let cueDense: readonly number[] | undefined;
    try {
      const embeddings = await this.ensureEmbeddings();
      if (embeddings !== undefined) cueDense = (await embeddings.embed([query.cue]))[0];
    } catch (error) {
      this.log.warn('associative memory cue embedding failed; using sparse matching', { error });
    }
    const atoms = query.includeHistory
      ? (await Promise.all(scoped.map((store) => store.allAtoms()))).flat()
      : scoped.flatMap((store) => store.listAtoms());
    const concepts = query.includeHistory
      ? (await Promise.all(scoped.map((store) => store.allRecords('concept')))).flat()
      : scoped.flatMap((store) => store.listConcepts());
    const edges = query.includeHistory
      ? (await Promise.all(scoped.map((store) => store.allRecords('edge')))).flat()
      : scoped.flatMap((store) => store.listEdges());
    const procedures = query.includeHistory
      ? (await Promise.all(scoped.map((store) => store.allRecords('procedure')))).flat()
      : scoped.flatMap((store) => store.listProcedures());
    const result = activate(
      query,
      atoms,
      concepts,
      edges,
      ASSOCIATIVE_MEMORY_PARAMS,
      this.now(),
      procedures,
      cueDense,
    );
    await this.persistSchemaLinks(scoped, result.trace, this.now());
    const ruled = filterRecallItems(result.items, code.rules);
    const items = orderConflictGroups(ruled.kept, code.rules);
    this.previousRecallIds = this.lastRecallIds;
    this.lastRecallIds = items.map((item) => item.id);
    if (query.reinforce === true) {
      await this.reinforceRecalled(scoped, items, this.now());
      await this.recordActivationCooccurrence(scoped, items, this.now());
    }
    if (ruled.dropped.length > 0) {
      await this.recordAudit('recall_filtered', { removed: ruled.dropped.length });
    }
    return { items, trace: result.trace, dropped: ruled.dropped };
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
      const injectedAt = this.now();
      this.working.touch(message, injectedAt);
      const sources = new Map<string, MemorySource>();
      for (const store of await this.storesFor('all')) {
        for (const note of store.listNotes()) sources.set(note.id, note.source);
      }
      const injectable = new Set<MemorySource>(['user', 'legacy']);
      const trusted = result.items.filter((item) => {
        const source = sources.get(item.noteId);
        return source !== undefined && injectable.has(source);
      });
      if (trusted.length !== result.items.length) {
        await this.recordAudit('injection_filtered', {
          removed: result.items.length - trusted.length,
        });
      }
      const fresh = trusted.filter((item) => !this.injectionState.has(item.text));
      if (fresh.length === 0) {
        const silent = this.working.reactivate(message, injectedAt);
        if (silent.length === 0) return '';
        return `${MEMORY_DATA_BOUNDARY}\n[short-term context]\n${silent
          .slice(0, 3)
          .map((item) => `- ${item.text}`)
          .join('\n')}`;
      }
      const rendered = renderRecallWithItems(
        { items: fresh, trace: result.trace },
        ASSOCIATIVE_MEMORY_PARAMS.injectionMaxTokens,
      );
      if (rendered.items.length === 0) return '';
      const injectedStores = await this.storesFor('all');
      await this.touchInjected(injectedStores, rendered.items, injectedAt);
      await this.recordActivationCooccurrence(injectedStores, rendered.items, injectedAt);
      this.injectionState.mark(rendered.items.map((item) => item.text));
      return rendered.text;
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
        await store.putAtom({
          ...atom,
          pinned: true,
          baseWeight: atom.baseWeight + 1,
          confidence: updateConfidence(atom.confidence, true, CONFIDENCE_RATE),
        });
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
      if (atom === undefined) continue;
      await this.detachAtomLinks(store, new Set([id]));
      await store.putAtom({
        ...atom,
        isDeleted: true,
        suppressed: true,
        confidence: updateConfidence(atom.confidence, false, CONFIDENCE_RATE),
      });
      await this.recordAudit('forget', { id });
      return;
    }
    for (const store of await this.storesFor('all')) {
      const procedure = store.getProcedure(id);
      if (procedure === undefined) continue;
      await this.forgetDerived(store, id);
      await this.recordAudit('forget', { id });
      return;
    }
    for (const store of await this.storesFor('all')) {
      const concept = store.getConcept(id);
      if (concept === undefined) continue;
      await this.forgetDerived(store, id);
      await this.recordAudit('forget', { id });
      return;
    }
  }

  async stats(scope: MemoryScopeSelector = 'all'): Promise<AssociativeMemoryStats> {
    if (!this.enabled()) {
      return {
        atoms: 0,
        concepts: 0,
        procedures: 0,
        edges: 0,
        notes: 0,
        suppressed: 0,
        pinned: 0,
        meanConfidence: 0,
        workingItems: 0,
        sourceCounts: { user: 0, tool: 0, external: 0, legacy: 0 },
        gatingMode: this.lastGatingMode,
      };
    }
    try {
      const scoped = await this.storesFor(scope);
      const counts = scoped.map((store) => store.counts());
      const sum = (
        field:
          | 'atoms'
          | 'concepts'
          | 'edges'
          | 'notes'
          | 'procedures'
          | 'suppressed'
          | 'pinned'
          | 'confidenceSum',
      ) => counts.reduce((total, value) => total + value[field], 0);
      const atoms = sum('atoms');
      const sourceCounts: Record<MemorySource, number> = {
        user: 0,
        tool: 0,
        external: 0,
        legacy: 0,
      };
      for (const source of ['user', 'tool', 'external', 'legacy'] as const) {
        sourceCounts[source] = counts.reduce(
          (total, value) => total + value.sourceCounts[source],
          0,
        );
      }
      return {
        atoms,
        concepts: sum('concepts'),
        edges: sum('edges'),
        notes: sum('notes'),
        procedures: sum('procedures'),
        suppressed: sum('suppressed'),
        pinned: sum('pinned'),
        meanConfidence: atoms === 0 ? 0 : sum('confidenceSum') / atoms,
        workingItems: this.working.snapshot(this.now()).size,
        sourceCounts,
        gatingMode: this.lastGatingMode,
      };
    } catch (error) {
      this.log.warn('associative memory stats failed', { error });
      return {
        atoms: 0,
        concepts: 0,
        procedures: 0,
        edges: 0,
        notes: 0,
        suppressed: 0,
        pinned: 0,
        meanConfidence: 0,
        workingItems: 0,
        sourceCounts: { user: 0, tool: 0, external: 0, legacy: 0 },
        gatingMode: this.lastGatingMode,
      };
    }
  }

  async list(options: ListOptions): Promise<AssociativeMemoryList> {
    if (!this.enabled()) return { atoms: [], concepts: [], procedures: [] };
    await this.importLegacyMemory();
    const scoped = await this.storesFor(options.scope);
    const limit = options.limit ?? ASSOCIATIVE_MEMORY_PARAMS.listLimit;
    let atoms: Atom[] = [];
    let concepts: Concept[] = [];
    let procedures: Procedure[] = [];
    const recent = (a: { lastActivatedAt: number }, b: { lastActivatedAt: number }) =>
      b.lastActivatedAt - a.lastActivatedAt;
    for (const store of scoped) {
      if (options.kind === undefined || options.kind === 'atom') {
        for await (const page of store.atomPages()) {
          atoms = [...atoms, ...page.filter((atom) => !atom.isDeleted)]
            .sort(
              (a, b) =>
                recent(a, b) || a.noteId.localeCompare(b.noteId) || a.spanStart - b.spanStart,
            )
            .slice(0, limit);
        }
      }
      if (options.kind === undefined || options.kind === 'concept') {
        for await (const page of store.recordPages('concept'))
          concepts = [...concepts, ...page].sort(recent).slice(0, limit);
      }
      if (options.kind === undefined || options.kind === 'procedure') {
        for await (const page of store.recordPages('procedure'))
          procedures = [...procedures, ...page].sort(recent).slice(0, limit);
      }
    }
    return { atoms, concepts, procedures };
  }

  async export(scope: MemoryScopeSelector = 'all'): Promise<AssociativeMemoryExport> {
    if (!this.enabled()) return { path: '', atoms: 0, concepts: 0, notes: 0 };
    await this.importLegacyMemory();
    const scoped = await this.storesFor(scope);
    const path = join(this.session.cwd || this.bootstrap.cwd, 'memory-export.json');
    const output = await open(path, 'w');
    const counts = { atoms: 0, concepts: 0, notes: 0 };
    try {
      await output.writeFile(`{"exportedAt":${JSON.stringify(new Date(this.now()).toISOString())}`);
      for (const [key, kind] of [
        ['atoms', 'atom'],
        ['concepts', 'concept'],
        ['procedures', 'procedure'],
        ['edges', 'edge'],
        ['notes', 'note'],
      ] as const) {
        await output.writeFile(`,${JSON.stringify(key)}:[`);
        let count = 0;
        for (const store of scoped) {
          const pages = kind === 'atom' ? store.atomPages() : store.recordPages(kind);
          for await (const page of pages) {
            for (const record of page) {
              await output.writeFile(`${count++ === 0 ? '' : ','}${JSON.stringify(record)}`);
            }
          }
        }
        await output.writeFile(']');
        if (key === 'atoms' || key === 'concepts' || key === 'notes') counts[key] = count;
      }
      await output.writeFile(`,"audit":${JSON.stringify(await this.audit(200))}}\n`);
    } finally {
      await output.close();
    }
    return { path, ...counts };
  }

  async replay(limit = 10): Promise<ReplayResult> {
    if (!this.enabled()) return { replayed: 0 };
    const store = await this.ensureStore(await this.projectScopeKey());
    const now = this.now();
    const edges = store.listEdges();
    const ranked = rankByNeedGain(
      (await store.allAtoms()).filter((atom) => !atom.isDeleted && atom.replayPriority > 0),
      (atom) => accessibility(atom, edges, now, ASSOCIATIVE_MEMORY_PARAMS),
      (atom) => atom.replayPriority,
      (left, right) => compareByText(left, right),
    );
    const candidates = interleave(ranked, limit, ASSOCIATIVE_MEMORY_PARAMS.replayStrata);
    if (candidates.length === 0) return { replayed: 0 };
    const selected = new Map(candidates.map((atom) => [atom.id, atom]));
    const neighbors = new Map<string, readonly Atom[]>();
    for (const edge of edges) {
      if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
      neighbors.set(edge.from, [...(neighbors.get(edge.from) ?? []), selected.get(edge.to)!]);
    }
    let current = edges;
    for (const atom of candidates) {
      const related = neighbors.get(atom.id) ?? [];
      if (related.length === 0) continue;
      const trained = hebbianConnect(
        [atom],
        related,
        current,
        ASSOCIATIVE_MEMORY_PARAMS,
        recentActivity(store.listEdges(), now, ASSOCIATIVE_MEMORY_PARAMS.contextWindowMs),
        now,
      );
      for (const id of trained.deleted) await store.deleteEdge(id);
      for (const edge of trained.edges) await store.putEdge(edge);
      current = trained.edges;
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

  async reconsolidate(targetId: string | undefined, text: string): Promise<ReconsolidateResult> {
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
    const note: NoteRecord = {
      id: `note_${ulid()}`,
      scopeKey: target.scopeKey,
      text,
      createdAt: now,
      source: store.getNote(target.noteId)?.source ?? 'tool',
    };
    const encoded = encodeAtoms(note, df, atoms.length, now, ASSOCIATIVE_MEMORY_PARAMS);
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
    const mismatch = newAtoms[0] === undefined ? 0 : cosine(newAtoms[0].vector, target.vector);
    const updatable =
      mismatch > ASSOCIATIVE_MEMORY_PARAMS.reconsolidateNovelThreshold &&
      mismatch < ASSOCIATIVE_MEMORY_PARAMS.reconsolidateMergeThreshold;
    const trained = hebbianConnect(
      newAtoms,
      [target, ...neighbors],
      store.listEdges(),
      ASSOCIATIVE_MEMORY_PARAMS,
      recentActivity(store.listEdges(), now, ASSOCIATIVE_MEMORY_PARAMS.contextWindowMs),
      now,
      (candidate, existing) =>
        updatable &&
        existing.id === target.id &&
        cosine(candidate.vector, existing.vector) > RECONSOLIDATE_THRESHOLD,
    );
    let superseded = false;
    for (const [id, state] of trained.superseded) {
      const old = store.getAtom(id);
      if (old !== undefined && !old.pinned) {
        await store.putAtom({
          ...old,
          validUntil: state.validUntil,
          suppressed: state.suppressed,
          replayPriority: old.replayPriority + 1,
        });
        superseded = true;
        await this.recordAudit('supersede', { from: newAtoms[0]?.id, to: id });
      }
    }
    await store.putNote(note);
    await this.persistTrainedAtoms(store, newAtoms, now, trained.edges);
    for (const id of trained.deleted) await store.deleteEdge(id);
    for (const edge of trained.edges) await store.putEdge(edge);
    await this.maintain(store, now);
    await this.recordAudit('reconsolidate', {
      targetId: target.id,
      newAtomIds: newAtoms.map((atom) => atom.id),
    });
    return {
      noteId: newAtoms[0]?.noteId ?? '',
      atomIds: newAtoms.map((atom) => atom.id),
      superseded,
    };
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

  async explain(query: RecallQuery): Promise<{
    readonly trace: readonly RecallTraceNode[];
    readonly dropped: readonly RecallDrop[];
  }> {
    const result = await this.recall(query);
    return { trace: [...result.trace], dropped: [...(result.dropped ?? [])] };
  }

  async codeBlock(): Promise<string> {
    if (!this.enabled()) return '';
    try {
      const code = await this.ensureCode();
      return code.guidance;
    } catch (error) {
      this.log.warn('associative memory code block failed', { error });
      return '';
    }
  }

  async rebuild(scope: MemoryScopeSelector = 'all'): Promise<void> {
    if (!this.enabled()) return;
    for (const store of await this.storesFor(scope)) {
      await store.runExclusive(async () => {
        await store.clearDerived();
        for await (const page of store.recordPages('note')) {
          for (const note of page) await this.trainNote(store, note, true);
        }
        await this.pruneAndEnforceBudgets(store);
      });
    }
    this.lastRecallIds = [];
    await this.recordAudit('rebuild', { scope });
  }

  private async trainNote(
    store: AssociativeMemoryStore,
    note: NoteRecord,
    rebuilding = false,
  ): Promise<readonly string[]> {
    const now = this.now();
    const atoms = store.listAtoms();
    const df = computeDf(atoms);
    let newAtoms = encodeAtoms(note, df, atoms.length, now, ASSOCIATIVE_MEMORY_PARAMS);
    if (rebuilding) {
      const restored: Atom[] = [];
      for (const encoded of newAtoms) {
        const previous = await store.getAtomById(encoded.id);
        if (previous !== undefined) {
          if (!previous.isDeleted && !previous.suppressed && previous.validUntil === undefined)
            restored.push(previous);
        } else restored.push(encoded);
      }
      newAtoms = restored;
    }
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
    const newIds = new Set(newAtoms.map((atom) => atom.id));
    const trained = hebbianConnect(
      newAtoms,
      context,
      store.edgesFrom(newIds),
      ASSOCIATIVE_MEMORY_PARAMS,
      recentActivity(store.listEdges(), now, ASSOCIATIVE_MEMORY_PARAMS.contextWindowMs),
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
    await this.persistTrainedAtoms(store, newAtoms, now, trained.edges);
    for (const id of trained.deleted) await store.deleteEdge(id);
    for (const edge of trained.edges) await store.putEdge(edge);
    await this.induceForgetting(store, newAtoms);
    await this.updateCooccurrence(store, newAtoms, context);
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
    await store.putNote(note);
    this.writesSinceMaintain += 1;
    await this.enforceBudgets(store, now);
    if (this.writesSinceMaintain >= MAINTAIN_EVERY_WRITES) {
      this.writesSinceMaintain = 0;
      await this.pruneAndEnforceBudgets(store);
    }
    if (now - this.lastMaintainedAt >= MAINTAIN_INTERVAL_MS) await this.maybeMaintain([store]);
    return atomIds;
  }

  private async persistTrainedAtoms(
    store: AssociativeMemoryStore,
    atoms: readonly Atom[],
    now: number,
    edges: readonly Edge[],
  ): Promise<void> {
    const evicted = await store.putAtoms(atoms, now, edges);
    if (evicted.length > 0) {
      await this.recordAudit('evict_atoms', {
        scope: store.scopeKey,
        count: evicted.length,
        ids: evicted.slice(0, AUDIT_ID_LIMIT),
      });
    }
  }

  private async maybeMaintain(stores: readonly AssociativeMemoryStore[]): Promise<void> {
    const now = this.now();
    if (now - this.lastMaintainedAt < MAINTAIN_INTERVAL_MS) return;
    this.lastMaintainedAt = now;
    for (const store of stores) await this.maintain(store, now);
  }

  private async pruneAndEnforceBudgets(store: AssociativeMemoryStore): Promise<void> {
    const edges = store.listEdges();
    const kept = new Set(pruneEdges(edges, ASSOCIATIVE_MEMORY_PARAMS).map((edge) => edge.id));
    for (const edge of edges) {
      if (!kept.has(edge.id)) await store.deleteEdge(edge.id);
    }
    await this.enforceBudgets(store, this.now());
    await this.refreshConcepts(store);
  }

  private async refreshConcepts(store: AssociativeMemoryStore): Promise<void> {
    const cluster = clusterIncremental(
      store.listAtoms(),
      store.listCooccurrences(),
      store.listConcepts(),
      ASSOCIATIVE_MEMORY_PARAMS,
      this.now(),
    );
    for (const concept of cluster.concepts) await store.putConcept(concept);
    for (const edge of cluster.edges) await store.putEdge(edge);
  }

  private async consolidate(store: AssociativeMemoryStore, now: number): Promise<void> {
    const pool = mostRecent(
      store.listAtoms().filter((atom) => !atom.suppressed && atom.validUntil === undefined),
      CONSOLIDATION_POOL,
    );
    if (pool.length < 2) return;
    let touched = 0;
    for (let left = 0; left < pool.length && touched < CONSOLIDATION_PAIR_BUDGET; left += 1) {
      for (let right = left + 1; right < pool.length; right += 1) {
        if (touched >= CONSOLIDATION_PAIR_BUDGET) break;
        if (!sharesContentTerm(pool[left]!, pool[right]!)) continue;
        const first = pool[left]!.id;
        const second = pool[right]!.id;
        const [a, b] = first < second ? [first, second] : [second, first];
        const key = `${a}|${b}`;
        const previous = store.getCooccurrence(key);
        await store.putCooccurrence(
          previous === undefined
            ? { key, a, b, count: 1, lastAt: now }
            : { ...previous, count: previous.count + 1, lastAt: now },
        );
        touched += 1;
      }
    }
    if (touched === 0) return;
    const cluster = clusterIncremental(
      store.listAtoms(),
      store.listCooccurrences(),
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
    await this.recordAudit('consolidate', { scope: store.scopeKey, pairs: touched });
  }

  private async maintain(store: AssociativeMemoryStore, now: number): Promise<void> {
    const pinned = new Set<string>();
    for (const atom of store.listAtoms()) if (atom.pinned) pinned.add(atom.id);
    for (const concept of store.listConcepts()) if (concept.pinned) pinned.add(concept.id);
    const salienceOf = new Map(store.listAtoms().map((atom) => [atom.id, atom.baseWeight]));
    const neglected = new Set(
      store
        .listAtoms()
        .filter(
          (atom) => now - atom.lastActivatedAt > ASSOCIATIVE_MEMORY_PARAMS.motivatedForgettingMs,
        )
        .map((atom) => atom.id),
    );
    const edges = store.listEdges();
    const decayed = restoreCaptured(
      applySleepDownscale(
        applyDecay(
          edges,
          now,
          ASSOCIATIVE_MEMORY_PARAMS,
          pinned,
          0.5 + ASSOCIATIVE_MEMORY_PARAMS.conceptFormationRate,
          salienceOf,
        ),
        ASSOCIATIVE_MEMORY_PARAMS,
      ),
      ASSOCIATIVE_MEMORY_PARAMS,
    );
    const kept = new Map<string, Edge>();
    for (const edge of pruneEdges(
      applyMotivatedForgetting(decayed, neglected, ASSOCIATIVE_MEMORY_PARAMS),
      ASSOCIATIVE_MEMORY_PARAMS,
    )) {
      kept.set(edge.id, edge);
    }
    for (const edge of edges) {
      if (edge.kind === 'schema' && now - edge.lastUsedAt > ASSOCIATIVE_MEMORY_PARAMS.schemaTtlMs) {
        await store.deleteEdge(edge.id);
        continue;
      }
      const next = kept.get(edge.id);
      if (next === undefined) await store.deleteEdge(edge.id);
      else if (next !== edge) await store.putEdge(next);
    }
    const coocs = store.listCooccurrences();
    const keptCoocs = new Set(
      pruneCooccurrences(
        coocs,
        now,
        ASSOCIATIVE_MEMORY_PARAMS,
        coocClusterThreshold(ASSOCIATIVE_MEMORY_PARAMS),
      ).map((cooc) => cooc.key),
    );
    for (const cooc of coocs) {
      if (!keptCoocs.has(cooc.key)) await store.deleteCooccurrence(cooc.key);
    }
    await this.consolidate(store, now);
    await this.enforceBudgets(store, now);
  }

  private async enforceBudgets(store: AssociativeMemoryStore, now: number): Promise<void> {
    const live = store
      .listAtoms()
      .filter((atom) => !atom.pinned && !atom.suppressed && atom.validUntil === undefined);
    const maxAtoms = this.atomBudget();
    if (live.length > maxAtoms) {
      const incident = store.listEdges();
      const retired = live
        .map((atom) => ({
          atom,
          score: accessibility(atom, incident, now, ASSOCIATIVE_MEMORY_PARAMS),
        }))
        .toSorted((left, right) => left.score - right.score || compareByText(left.atom, right.atom))
        .slice(0, live.length - maxAtoms)
        .map((entry) => entry.atom);
      if (retired.length > 0) {
        const retiredIds = new Set(retired.map((atom) => atom.id));
        await this.retireAtoms(store, retiredIds, this.now());
        await this.recordAudit('evict_atoms', {
          scope: store.scopeKey,
          count: retiredIds.size,
          ids: [...retiredIds].slice(0, AUDIT_ID_LIMIT),
        });
      }
    }
  }

  private async induceForgetting(
    store: AssociativeMemoryStore,
    newAtoms: readonly Atom[],
  ): Promise<void> {
    if (newAtoms.length === 0) return;
    const activeIds = new Set(newAtoms.map((atom) => atom.id));
    const competing = new Set<string>();
    for (const atom of store.listAtoms()) {
      if (activeIds.has(atom.id)) continue;
      if (!newAtoms.some((candidate) => sharesContentTerm(candidate, atom))) continue;
      competing.add(atom.id);
    }
    if (competing.size === 0) return;
    const edges = store
      .listEdges()
      .filter((edge) => edge.kind === 'hebbian' && competing.has(edge.from))
      .toSorted((left, right) => right.weight - left.weight || (left.id < right.id ? -1 : 1))
      .slice(0, ASSOCIATIVE_MEMORY_PARAMS.interferenceMaxEdges);
    for (const edge of edges) {
      await store.putEdge({
        ...edge,
        weight: edge.weight * ASSOCIATIVE_MEMORY_PARAMS.interferenceForgetting,
      });
    }
  }

  private async updateCooccurrence(
    store: AssociativeMemoryStore,
    newAtoms: readonly Atom[],
    context: readonly Atom[],
  ): Promise<void> {
    const now = this.now();
    const window = mostRecent(context, COOC_CONTEXT_LIMIT);
    for (const a of newAtoms) {
      for (const b of window) {
        if (a.id === b.id) continue;
        const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        const key = `${x}|${y}`;
        const previous = store.getCooccurrence(key);
        const next: Cooccurrence =
          previous === undefined
            ? { key, a: x, b: y, count: 1, lastAt: now }
            : { ...previous, count: previous.count + 1, lastAt: now };
        await store.putCooccurrence(next);
      }
    }
  }

  private async releaseStores(): Promise<void> {
    const closing = [...this.storeHandles].map(([key, handle]) => releaseStore(key, handle));
    this.storeHandles.clear();
    await Promise.all(closing);
  }

  private async ensureStore(scopeKey: string): Promise<AssociativeMemoryStore> {
    const root = join(this.bootstrap.storeDir, storeRootName);
    const key = join(root, scopeKey);
    const current = this.storeHandles.get(key);
    if (current !== undefined) return current.pending;
    const handle = acquireStore(key, () =>
      AssociativeMemoryStore.open(scopeKey, root, this.noteBudget(), this.atomBudget()),
    );
    this.storeHandles.set(key, handle);
    try {
      return await handle.pending;
    } catch (error) {
      if (this.storeHandles.get(key) === handle) this.storeHandles.delete(key);
      throw error;
    }
  }

  private async storesFor(
    scope: MemoryScopeSelector | undefined,
  ): Promise<readonly AssociativeMemoryStore[]> {
    if (scope === 'global') return [await this.ensureStore(globalScopeKey)];
    if (scope === 'project') return [await this.ensureStore(await this.projectScopeKey())];
    const scoped = [
      await this.ensureStore(await this.projectScopeKey()),
      await this.ensureStore(globalScopeKey),
    ];
    if (typeof this.session.sessionId === 'string' && this.session.sessionId.length > 0) {
      const key = sessionMemoryScopeKey(this.session.sessionId);
      const path = join(this.bootstrap.storeDir, storeRootName, key);
      const { existsSync } = await import('node:fs');
      if (this.storeHandles.has(path) || existsSync(path)) scoped.push(await this.ensureStore(key));
    }
    return scoped;
  }

  protected atomBudget(): number {
    return MAX_ATOMS;
  }

  protected noteBudget(): number {
    return MAX_NOTES;
  }

  private async ensureEmbeddings(): Promise<EmbeddingsClient | undefined> {
    if (this.embeddingsClient !== undefined) return this.embeddingsClient;
    const now = this.now();
    if (this.embeddingsResolved && now - this.embeddingsResolvedAt < EMBEDDINGS_RETRY_MS) {
      return undefined;
    }
    this.embeddingsResolved = true;
    this.embeddingsResolvedAt = now;
    const code = await this.ensureCode();
    if (!codeAllowsEmbeddings(code)) {
      if (!this.embeddingsBlockedLogged) {
        this.embeddingsBlockedLogged = true;
        await this.recordAudit('embeddings_blocked');
      }
      return undefined;
    }
    const options = resolveEmbeddingsOptions(this.bootstrap);
    if (options === undefined) return undefined;
    this.embeddingsClient = createHttpEmbeddingsClient(options);
    return this.embeddingsClient;
  }

  private async ensureCode(): Promise<MemoryCode> {
    const path = join(this.bootstrap.homeDir, storeRootName, codeFileName);
    const mtime = await fileMtimeMs(path);
    if (this.codeLoaded && mtime === this.codeMtimeMs) return this.code;
    this.code = await loadCodeFile(path, DEFAULT_CODE);
    this.codeLoaded = true;
    this.codeMtimeMs = mtime;
    return this.code;
  }

  private async projectScopeKey(): Promise<string> {
    const key = this.projectKey();
    if (this.migratedProjectScope) return key;
    const cwd = this.session.cwd || this.bootstrap.cwd;
    const legacyKeys = new Set<string>([legacyProjectIdFromCwd(cwd)]);
    legacyKeys.delete(key);
    for (const legacyKey of legacyKeys) {
      if (!(await this.renameLegacyStore(legacyKey, key))) {
        throw new Error(
          'Associative memory scope migration failed; retry after the store is available',
        );
      }
    }
    this.migratedProjectScope = true;
    return key;
  }

  private async renameLegacyStore(from: string, to: string): Promise<boolean> {
    const root = join(this.bootstrap.storeDir, storeRootName);
    const fromKey = join(root, from);
    const toKey = join(root, to);
    try {
      const { existsSync } = await import('node:fs');
      if (!existsSync(fromKey) || existsSync(toKey)) return true;
      const handle = stores.get(fromKey);
      if (handle !== undefined) {
        if (handle.refs > 0) return false;
        await (handle.closing ?? releaseStore(fromKey, handle));
        if (stores.has(fromKey)) return false;
      }
      const { rename } = await import('node:fs/promises');
      await rename(fromKey, toKey);
      this.log.debug('associative memory project scope migrated', { from, to });
      return true;
    } catch (error) {
      this.log.warn('associative memory project scope migration failed', { from, to, error });
      return false;
    }
  }

  private projectKey(): string {
    return projectIdFromCwd(this.session.cwd || this.bootstrap.cwd);
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
      if (message === undefined || !isRealUserInput(message)) continue;
      for (const part of message.content ?? []) {
        if ('text' in part && part.text) return part.text;
      }
    }
    return '';
  }
}

async function fileMtimeMs(path: string): Promise<number> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAssociativeMemoryService,
  AssociativeMemoryService,
  ScopeActivation.OnScopeCreated,
  'associativeMemory',
);
