import { join } from 'pathe';
import { ulid } from 'ulid';
import { writeFile } from 'node:fs/promises';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { classifyGating } from './gating';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { legacyProjectIdFromCwd, projectIdFromCwd } from '#/app/memory/memoryPaths';
import { LifecycleScope } from '#/app/scopes';
import { alreadyRendered, markRendered } from '#/agent/injection/renderedLines';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { activate } from './activate';
import type { AuditEntry } from './audit';
import {
  appendAudit,
  auditPath,
  readAudit,
  type AuditKind,
} from './audit';
import {
  applyWriteRules,
  codeAllowsEmbeddings,
  filterRecallItems,
  orderConflictGroups,
} from './code';
import {
  createHttpEmbeddingsClient,
  resolveEmbeddingsOptions,
  type EmbeddingsClient,
} from './embeddings';
import { DEFAULT_CODE } from './code/defaults';
import { loadCodeFile } from './code/load';
import { clusterIncremental, coocClusterThreshold } from './cluster';
import { compareByText } from './terms';
import { accessibility } from './accessibility';
import {
  applyDecay,
  applyMotivatedForgetting,
  applySleepDownscale,
  pruneCooccurrences,
  pruneEdges,
  restoreCaptured,
} from './decay';
import { collectSchemaLinks } from './schema';
import { interleave, rankByNeedGain } from './scheduler';
import { noteFingerprint, noteTerms } from './dedupe';
import { encodeAtoms } from './encode';
import { distillProcedures } from './procedure';
import {
  approveProposal as approveProposalInStore,
  proposeRule as proposeRuleInStore,
} from './code/proposals';
import { ASSOCIATIVE_MEMORY_FLAG_ID } from './flag';
import { ASSOCIATIVE_MEMORY_PARAMS } from './params';
import { MEMORY_DATA_BOUNDARY, renderRecall } from './render';
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
  RecallDrop,
  RecallItem,
  MemorySource,
} from './types';
import { computeDf, cosine } from './vector';
import { recentActivity } from './activity';
import { updateConfidence } from './metacognition';
import { WorkingBuffer } from './workingBuffer';
import { hebbianConnect, sharesContentTerm } from './train';

export interface IAssociativeMemoryService {
  readonly _serviceBrand: undefined;
  writeNote(
    text: string,
    scope?: MemoryScopeSelector,
    source?: MemorySource,
  ): Promise<WriteResult>;
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

export const IAssociativeMemoryService =
  createDecorator<IAssociativeMemoryService>('associativeMemoryService');

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
const MAX_OPEN_STORES = 8;

interface StoreHandle {
  readonly pending: Promise<AssociativeMemoryStore>;
  refs: number;
  idleSince: number;
}

function acquireStore(
  key: string,
  open: () => Promise<AssociativeMemoryStore>,
): Promise<AssociativeMemoryStore> {
  let handle = stores.get(key);
  if (handle === undefined) {
    handle = { pending: open(), refs: 0, idleSince: 0 };
    stores.set(key, handle);
    handle.pending.catch(() => {
      if (stores.get(key) === handle) stores.delete(key);
    });
  }
  handle.refs += 1;
  handle.idleSince = 0;
  return handle.pending;
}

function releaseStore(key: string): void {
  const handle = stores.get(key);
  if (handle === undefined) return;
  handle.refs = Math.max(0, handle.refs - 1);
  if (handle.refs === 0) handle.idleSince = Date.now();
}

function trimStores(): void {
  if (stores.size <= MAX_OPEN_STORES) return;
  const idle = [...stores.entries()]
    .filter(([, handle]) => handle.refs === 0 && handle.idleSince > 0)
    .sort((a, b) => a[1].idleSince - b[1].idleSince);
  for (const [key, handle] of idle) {
    if (stores.size <= MAX_OPEN_STORES) return;
    stores.delete(key);
    void handle.pending
      .then((store) => store.close())
      .catch(() => {
        return undefined;
      });
  }
}

const noteShapes = new WeakMap<NoteRecord, { fingerprint: string; terms: readonly string[] }>();

function noteShape(note: NoteRecord): { fingerprint: string; terms: readonly string[] } {
  const cached = noteShapes.get(note);
  if (cached !== undefined) return cached;
  const shape = { fingerprint: noteFingerprint(note.text), terms: noteTerms(note.text) };
  noteShapes.set(note, shape);
  return shape;
}

export class AssociativeMemoryService
  extends Disposable
  implements IAssociativeMemoryService
{
  declare readonly _serviceBrand: undefined;

  private code: MemoryCode = DEFAULT_CODE;
  private codeLoaded = false;
  private codeMtimeMs = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private migratedProjectScope = false;
  private embeddingsClient: EmbeddingsClient | undefined;
  private embeddingsResolved = false;
  private embeddingsResolvedAt = 0;
  private embeddingsBlockedLogged = false;
  private lastMaintainedAt = 0;
  private lastWriteText: string | undefined;
  private lastRecallCue: string | undefined;
  private lastGatingMode = 'retrieve';
  private writesSinceMaintain = 0;
  private readonly storeKeys = new Set<string>();
  private readonly storePending = new Map<string, Promise<AssociativeMemoryStore>>();
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
        for (const key of this.storeKeys) releaseStore(key);
        this.storeKeys.clear();
      }),
    );
  }

  protected now(): number {
    return Date.now();
  }

  async writeNote(
    text: string,
    scope: MemoryScopeSelector = 'project',
    source: MemorySource = 'user',
  ): Promise<WriteResult> {
    if (!this.enabled() || text.trim().length === 0) {
      return { noteId: '', atomIds: [], blockedByCode: false, scope, decision: 'noop' };
    }
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
    const store = await this.ensureStore(scope === 'global' ? globalScopeKey : await this.projectScopeKey());
    const now = this.now();
    const scopeKey = store.scopeKey;
    const gating = classifyGating({
      sameCueRepeated: this.lastWriteText !== undefined && noteFingerprint(this.lastWriteText) === noteFingerprint(text),
      unstableRecall: this.lastRecallIds.length === 0 && store.listNotes().length > 0,
      newScopeOrTopic: store.listNotes().length === 0,
      positiveFeedback: false,
    });
    this.lastWriteText = text;

    const candidate = this.findMergeCandidate(store, text);
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
    const atomIds = await this.enqueue(() => this.trainNote(store, note));
    await this.recordAudit('write_allowed', { scope, noteId: note.id, atoms: atomIds.length, gating: gating.mode });
    return {
      noteId: note.id,
      atomIds: [...atomIds],
      blockedByCode: false,
      scope,
      decision: 'added',
    };
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
        if (store.getAtom(link.from) === undefined || store.getAtom(link.to) === undefined) continue;
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

  private findMergeCandidate(
    store: AssociativeMemoryStore,
    text: string,
  ): { readonly note: NoteRecord } | undefined {
    const fingerprint = noteFingerprint(text);
    for (const note of store.listNotes()) {
      if (noteShape(note).fingerprint === fingerprint) return { note };
    }
    return undefined;
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
    await this.detachAtomLinks(store, doomed);
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
    await store.deleteConcept(id);
    await store.deleteProcedure(id);
  }

  async recall(query: RecallQuery): Promise<RecallResult> {
    if (!this.enabled()) return { items: [], trace: [] };
    const code = await this.ensureCode();
    const scoped = await this.storesFor(query.scope);
    await this.maybeMaintain(scoped);
    const gating = classifyGating({
      sameCueRepeated: this.lastRecallCue === query.cue,
      unstableRecall: this.previousRecallIds.length > 0 &&
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
      const sessionKey = this.session.sessionId;
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
      const fresh = trusted.filter((item) => !alreadyRendered(sessionKey, item.text));
      if (fresh.length === 0) {
        const silent = this.working.reactivate(message, injectedAt);
        if (silent.length === 0) return '';
        return `${MEMORY_DATA_BOUNDARY}\n[short-term context]\n${silent
          .slice(0, 3)
          .map((item) => `- ${item.text}`)
          .join('\n')}`;
      }
      markRendered(sessionKey, fresh.map((item) => item.text));
      const injectedStores = await this.storesFor('all');
      await this.touchInjected(injectedStores, fresh, injectedAt);
      await this.recordActivationCooccurrence(injectedStores, fresh, injectedAt);
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
        atoms: 0, concepts: 0, procedures: 0, edges: 0, notes: 0, suppressed: 0, pinned: 0,
        meanConfidence: 0, workingItems: 0,
        sourceCounts: { user: 0, tool: 0, external: 0, legacy: 0 },
        gatingMode: this.lastGatingMode,
      };
    }
    try {
      const scoped = await this.storesFor(scope);
      const atoms = scoped
        .flatMap((store) => store.listAtoms())
        .filter((atom) => !atom.isDeleted);
      const concepts = scoped.flatMap((store) => store.listConcepts());
      const sourceCounts: Record<MemorySource, number> = {
        user: 0,
        tool: 0,
        external: 0,
        legacy: 0,
      };
      for (const store of scoped) {
        for (const note of store.listNotes()) sourceCounts[note.source ?? 'legacy'] += 1;
      }
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
        meanConfidence:
          atoms.length === 0
            ? 0
            : atoms.reduce((sum, atom) => sum + atom.confidence, 0) / atoms.length,
        workingItems: this.working.snapshot(this.now()).size,
        sourceCounts,
        gatingMode: this.lastGatingMode,
      };
    } catch (error) {
      this.log.warn('associative memory stats failed', { error });
      return {
        atoms: 0, concepts: 0, procedures: 0, edges: 0, notes: 0, suppressed: 0, pinned: 0,
        meanConfidence: 0, workingItems: 0,
        sourceCounts: { user: 0, tool: 0, external: 0, legacy: 0 },
        gatingMode: this.lastGatingMode,
      };
    }
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
    const path = join(this.session.cwd || this.bootstrap.cwd, 'memory-export.json');
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
    const store = await this.ensureStore(await this.projectScopeKey());
    const now = this.now();
    const edges = store.listEdges();
    const ranked = rankByNeedGain(
      store.listAtoms().filter((atom) => atom.replayPriority > 0),
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
    const mismatch =
      newAtoms[0] === undefined ? 0 : cosine(newAtoms[0].vector, target.vector);
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
    for (const atom of newAtoms) await store.putAtom(atom);
    for (const id of trained.deleted) await store.deleteEdge(id);
    for (const edge of trained.edges) await store.putEdge(edge);
    await store.putNote({
      id: `note_${ulid()}`,
      scopeKey: target.scopeKey,
      text,
      createdAt: now,
      source: store.getNote(target.noteId)?.source ?? 'tool',
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
      const notes = store.listNotes();
      await store.clearGraph();
      for (const note of notes) {
        await this.trainNote(store, note);
      }
    }
    this.lastRecallIds = [];
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
    for (const atom of newAtoms) await store.putAtom(atom);
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
    if (this.writesSinceMaintain >= MAINTAIN_EVERY_WRITES) {
      this.writesSinceMaintain = 0;
      await this.pruneAndEnforceBudgets(store);
    }
    if (now - this.lastMaintainedAt >= MAINTAIN_INTERVAL_MS) await this.maybeMaintain([store]);
    return atomIds;
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
      if (
        edge.kind === 'schema' &&
        now - edge.lastUsedAt > ASSOCIATIVE_MEMORY_PARAMS.schemaTtlMs
      ) {
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
      .filter((atom) => !atom.suppressed && atom.validUntil === undefined);
    const maxAtoms = this.atomBudget();
    if (live.length > maxAtoms) {
      const incident = store.listEdges();
      const retired = live
        .filter((atom) => !atom.pinned)
        .map((atom) => ({
          atom,
          score: accessibility(atom, incident, now, ASSOCIATIVE_MEMORY_PARAMS),
        }))
        .toSorted(
          (left, right) => left.score - right.score || compareByText(left.atom, right.atom),
        )
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
    const notes = store.listNotes();
    const maxNotes = this.noteBudget();
    if (notes.length <= maxNotes) return;
    const liveNotes = new Set(store.listAtoms().map((atom) => atom.noteId));
    const removable = notes
      .filter((note) => !liveNotes.has(note.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, notes.length - maxNotes);
    for (const note of removable) await store.deleteNote(note.id);
    if (removable.length > 0) {
      await this.recordAudit('evict_notes', { scope: store.scopeKey, count: removable.length });
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

  private async ensureStore(scopeKey: string): Promise<AssociativeMemoryStore> {
    const key = join(this.bootstrap.storeDir, storeRootName, scopeKey);
    let pending = this.storePending.get(key);
    if (pending === undefined) {
      this.storeKeys.add(key);
      pending = acquireStore(key, () =>
        AssociativeMemoryStore.open(scopeKey, join(this.bootstrap.storeDir, storeRootName)),
      );
      this.storePending.set(key, pending);
      trimStores();
    }
    return pending;
  }

  private async storesFor(
    scope: MemoryScopeSelector | undefined,
  ): Promise<readonly AssociativeMemoryStore[]> {
    if (scope === 'global') return [await this.ensureStore(globalScopeKey)];
    if (scope === 'project') return [await this.ensureStore(await this.projectScopeKey())];
    return [await this.ensureStore(await this.projectScopeKey()), await this.ensureStore(globalScopeKey)];
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
    this.migratedProjectScope = true;
    const cwd = this.session.cwd || this.bootstrap.cwd;
    const legacyKeys = new Set<string>([
      legacyProjectIdFromCwd(cwd),
      legacyProjectIdFromCwd(this.bootstrap.cwd),
      projectIdFromCwd(this.bootstrap.cwd),
    ]);
    legacyKeys.delete(key);
    for (const legacyKey of legacyKeys) await this.renameLegacyStore(legacyKey, key);
    return key;
  }

  private async renameLegacyStore(from: string, to: string): Promise<void> {
    const root = join(this.bootstrap.storeDir, storeRootName);
    const fromKey = join(root, from);
    const toKey = join(root, to);
    try {
      const { existsSync } = await import('node:fs');
      if (!existsSync(fromKey) || existsSync(toKey)) return;
      const handle = stores.get(fromKey);
      if (handle !== undefined) {
        stores.delete(fromKey);
        await handle.pending.then((store) => store.close()).catch(() => undefined);
      }
      const { rename } = await import('node:fs/promises');
      await rename(fromKey, toKey);
      this.log.debug('associative memory project scope migrated', { from, to });
    } catch (error) {
      this.log.warn('associative memory project scope migration failed', { from, to, error });
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
