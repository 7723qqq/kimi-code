import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isInstantiationServiceDisposedError } from '@moonshot-ai/agent-core-v2';
import type { UserPromptOrigin } from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IAgentContextMemoryService,
  IWireService,
  ISessionIndex,
  ISessionMetadata,
  IAgentLoopService,
  followSessionLifecycles,
  getLiveSessionById,
  type IDisposable,
  type Scope,
  type SessionMeta,
} from '@moonshot-ai/agent-core-v2';
import {
  TranscriptStore,
  groupMessagesIntoSnapshot,
  isPlainAgentId,
  turnId as exportTurnKey,
  type AgentDescriptor,
  type AgentTranscript,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@moonshot-ai/transcript';

import { projectPromptContentParts } from '../messages/messageProjection';
import {
  bindSessionTranscript,
  descriptorFromMeta,
  type TranscriptBinding,
  type TranscriptBindingLogger,
} from './coreBinding';
import { allocateExportTurn } from './coreEventMap';
import { WireProjectionService } from './wireProjection';

const SESSIONS_ROOT = 'sessions';
const MAIN_AGENT_ID = 'main';
const STATE_FILE = 'state.json';

export interface TranscriptServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: TranscriptBindingLogger;
}

interface LiveEntry {
  readonly store: TranscriptStore;
  readonly binding: TranscriptBinding;
  readonly ready: Promise<void>;
  readonly agentBackfills: Map<string, Promise<void>>;
  readonly opsJournals: Map<string, AgentOpsJournal>;
  readonly undoGenerations: Map<string, number>;
}

interface AgentOpsJournal {
  nextSeq: number;
  batches: { seq: number; ops: TranscriptOperation[] }[];
}

export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;

export interface TranscriptOpsCatchup {
  readonly batches: readonly { seq: number; ops: readonly TranscriptOperation[] }[];
  readonly latestSeq: number;
  readonly complete: boolean;
}

export class TranscriptService {
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<
    string,
    Set<(event: TranscriptChangeEvent, seq: number) => void>
  >();
  private readonly healTimers = new Map<
    string,
    { ordinals: Set<number>; timer: NodeJS.Timeout; firstScheduledAt: number }
  >();
  readonly projections: WireProjectionService;

  constructor(private readonly deps: TranscriptServiceDeps) {
    this.projections = new WireProjectionService(deps.homeDir);
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => this.dropSession(sessionId));
      const d2 = service.onDidArchiveSession(({ sessionId }) => this.dropSession(sessionId));
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  forSessionLive(sessionId: string): TranscriptStore | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) {
        return existing.store;
      }
      this.dropSession(sessionId);
      return undefined;
    }
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(sessionId);
    let binding: TranscriptBinding;
    try {
      binding = bindSessionTranscript(
        store,
        session,
        this.deps.logger,
        (event) => this.handleLiveOps(sessionId, event),
        (agentId) => this.rebuildAfterUndo(sessionId, agentId),
      );
    } catch (error) {
      if (isInstantiationServiceDisposedError(error)) {
        return undefined;
      }
      throw error;
    }
    this.live.set(sessionId, {
      store,
      binding,
      ready: (async () => {
        await this.backfillMain(sessionId, store);
        if (this.live.get(sessionId)?.store === store) {
          binding.seedPendingInteractions(MAIN_AGENT_ID);
        }
      })(),
      agentBackfills: new Map(),
      opsJournals: new Map(),
      undoGenerations: new Map(),
    });
    return store;
  }

  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

  async ensureAgentHistory(sessionId: string, agentId: string): Promise<void> {
    if (agentId === MAIN_AGENT_ID) return this.whenReady(sessionId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    await entry.ready;
    let backfill = entry.agentBackfills.get(agentId);
    if (backfill === undefined) {
      backfill = this.backfillAgent(sessionId, entry.store, agentId);
      entry.agentBackfills.set(agentId, backfill);
    }
    await backfill;
    if (this.live.get(sessionId)?.store === entry.store) {
      entry.binding.seedPendingInteractions(agentId);
    }
  }

  private async backfillMain(sessionId: string, store: TranscriptStore): Promise<void> {
    await this.backfillAgent(sessionId, store, MAIN_AGENT_ID);
    if (this.live.get(sessionId)?.store !== store) return;
    try {
      const session = getLiveSessionById(this.deps.core.accessor, sessionId);
      const meta = await session?.accessor.get(ISessionMetadata).read();
      for (const [agentId, agentMeta] of Object.entries(meta?.agents ?? {})) {
        store.describeAgent(descriptorFromMeta(agentId, agentMeta));
      }
    } catch {}
  }

  private async backfillAgent(
    sessionId: string,
    store: TranscriptStore,
    agentId: string,
  ): Promise<void> {
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readColdSnapshot(sessionId, agentId);
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: history backfill failed, continuing without it',
      );
    }
    if (this.live.get(sessionId)?.store !== store) return;
    const transcript = store.ensureAgent(agentId);
    if (snapshot !== undefined) {
      const superseded = supersededColdAttachmentIds(snapshot, transcript);
      const ops = snapshotToOps(snapshot, (turn) =>
        healTurnOps(turn, transcript.getTurn(turn.turnId)),
      ).filter(
        (op) => op.op !== 'attachment.upsert' || !superseded.has(op.attachment.attachmentId),
      );
      const overlay = this.liveTurnOverlay(sessionId, agentId, transcript, snapshot);
      if (overlay !== undefined) ops.push(overlay);
      ops.push(...this.livePromptBackfill(sessionId, agentId));
      const result = transcript.apply(ops);
      if (result.gap !== undefined) {
        this.deps.logger?.warn(
          { sessionId, agentId, gap: result.gap },
          'transcript: backfill append gap',
        );
      }
      this.dispatchOps(sessionId, { agentId, ops });
      this.live.get(sessionId)?.binding.syncFromStore(agentId);
    }
    const existing = store.agents().find((d) => d.agentId === agentId);
    const hasContent =
      snapshot !== undefined && (snapshot.items.length > 0 || snapshot.tasks.length > 0);
    if (existing !== undefined || hasContent) {
      store.describeAgent({
        agentId,
        type: existing?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
        parentAgentId: existing?.parentAgentId,
        label: existing?.label,
        createdAt: existing?.createdAt,
      });
    }
  }

  onSessionOps(
    sessionId: string,
    listener: (event: TranscriptChangeEvent, seq: number) => void,
  ): IDisposable | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    let listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.opsListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        const entry = this.opsListeners.get(sessionId);
        if (entry === undefined) return;
        entry.delete(listener);
        if (entry.size === 0) this.opsListeners.delete(sessionId);
      },
    };
  }

  private dispatchOps(sessionId: string, event: TranscriptChangeEvent): void {
    const seq = this.journalOps(sessionId, event);
    const listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event, seq);
      } catch {}
    }
  }

  private journalOps(sessionId: string, event: TranscriptChangeEvent): number {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return 0;
    let journal = entry.opsJournals.get(event.agentId);
    if (journal === undefined) {
      journal = { nextSeq: 1, batches: [] };
      entry.opsJournals.set(event.agentId, journal);
    }
    const seq = journal.nextSeq++;
    journal.batches.push({ seq, ops: [...event.ops] });
    if (journal.batches.length > TRANSCRIPT_OPS_JOURNAL_CAPACITY) journal.batches.shift();
    return seq;
  }

  getSeqWatermark(sessionId: string, agentId: string): number {
    const journal = this.live.get(sessionId)?.opsJournals.get(agentId);
    return journal === undefined ? 0 : journal.nextSeq - 1;
  }

  getOpsSince(
    sessionId: string,
    agentId: string,
    sinceSeq: number,
  ): TranscriptOpsCatchup | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    const journal = this.live.get(sessionId)?.opsJournals.get(agentId);
    const latestSeq = journal === undefined ? 0 : journal.nextSeq - 1;
    if (sinceSeq > latestSeq) return { batches: [], latestSeq, complete: false };
    const batches = journal?.batches.filter((batch) => batch.seq > sinceSeq) ?? [];
    const oldest = journal?.batches[0]?.seq;
    const complete = batches.length === 0 || (oldest !== undefined && oldest <= sinceSeq + 1);
    return { batches, latestSeq, complete };
  }

  private handleLiveOps(sessionId: string, event: TranscriptChangeEvent): void {
    this.dispatchOps(sessionId, event);
    for (const op of event.ops) {
      if (op.op === 'turn.upsert' && TERMINAL_TURN_STATES.has(op.turn.state)) {
        this.scheduleTurnHeal(sessionId, event.agentId, op.turn.ordinal);
      }
    }
  }

  private scheduleTurnHeal(sessionId: string, agentId: string, ordinal: number): void {
    const key = `${sessionId}:${agentId}`;
    const existing = this.healTimers.get(key);
    if (existing !== undefined) {
      existing.ordinals.add(ordinal);
      if (Date.now() - existing.firstScheduledAt < TURN_HEAL_MAX_DELAY_MS) existing.timer.refresh();
      return;
    }
    const ordinals = new Set([ordinal]);
    const firstScheduledAt = Date.now();
    const timer = setTimeout(() => {
      this.healTimers.delete(key);
      void this.healEndedTurns(sessionId, agentId, ordinals);
    }, TURN_HEAL_DEBOUNCE_MS);
    timer.unref();
    this.healTimers.set(key, { ordinals, timer, firstScheduledAt });
  }

  private liveTurnOverlay(
    sessionId: string,
    agentId: string,
    transcript: AgentTranscript,
    snapshot: AgentTranscriptSnapshot,
  ): TranscriptOperation | undefined {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent =
      session === undefined
        ? undefined
        : session.accessor.get(IAgentLifecycleService).handleOf(agentId);
    const status = agent?.accessor.get(IAgentLoopService).snapshot();
    if (status?.state !== 'running' || status.activeTurnId === undefined) return undefined;
    const activePromptId = status.activePromptId;
    const wireId = status.activeTurnId;
    const candidate = exportTurnKey(wireId);
    const liveAtWire = transcript.getTurn(candidate);
    const snapshotAtWire = snapshot.items.find(
      (item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === candidate,
    );
    let snapshotTip: TranscriptTurn | undefined;
    for (const item of snapshot.items) {
      if (item.kind === 'turn') snapshotTip = item;
    }
    let liveRunning: TranscriptTurn | undefined;
    for (const item of transcript.getItems()) {
      if (item.kind === 'turn' && item.state === 'running') liveRunning = item;
    }
    const tipIsWire = snapshotTip !== undefined && snapshotTip.ordinal === wireId;
    const adoptLive =
      liveRunning !== undefined &&
      (!snapshot.items.some((item) => item.kind === 'turn' && item.turnId === liveRunning.turnId) ||
        liveRunning.turnId === snapshotTip?.turnId);
    let turnId: string;
    let ordinal: number;
    let header: TranscriptTurn | undefined;
    if (adoptLive && liveRunning !== undefined) {
      turnId = liveRunning.turnId;
      ordinal = liveRunning.ordinal;
      header = liveRunning;
    } else if (tipIsWire && snapshotTip !== undefined) {
      turnId = snapshotTip.turnId;
      ordinal = snapshotTip.ordinal;
      header = transcript.getTurn(turnId) ?? snapshotTip;
    } else {
      let highWater = -1;
      for (const item of transcript.getItems()) {
        if (item.kind === 'turn' && item.ordinal > highWater) highWater = item.ordinal;
      }
      for (const item of snapshot.items) {
        if (item.kind === 'turn' && item.ordinal > highWater) highWater = item.ordinal;
      }
      const alloc = allocateExportTurn(wireId, highWater, liveAtWire ?? snapshotAtWire, false);
      turnId = alloc.turnId;
      ordinal = alloc.ordinal;
      header = transcript.getTurn(turnId);
    }
    return {
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal,
        state: 'running',
        triggerPromptId: header?.triggerPromptId ?? activePromptId,
        origin: header?.origin ?? { kind: 'other' },
        prompt: header?.prompt,
        attachmentIds: header?.attachmentIds,
        startedAt: header?.startedAt,
      },
    };
  }

  private livePromptBackfill(sessionId: string, agentId: string): TranscriptOperation[] {
    const agent = getLiveSessionById(this.deps.core.accessor, sessionId)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(agentId);
    if (agent === undefined) return [];
    const loop = agent.accessor.get(IAgentLoopService);
    const snapshot = loop.snapshot();
    const ops: TranscriptOperation[] = [];
    const activeHandle =
      snapshot.activePromptId === undefined
        ? undefined
        : loop.promptHandle(snapshot.activePromptId);
    if (activeHandle !== undefined) {
      const activeOrigin = activeHandle.message.origin;
      ops.push({
        op: 'prompt.upsert',
        prompt: {
          promptId: activeHandle.id,
          status: 'running',
          userMessageId: activeHandle.userMessageId,
          content: projectPromptContentParts(activeHandle.message.content),
          createdAt: activeHandle.createdAt,
          clientMetadata:
            activeOrigin?.kind === 'user' || activeOrigin?.kind === 'skill_activation'
              ? activeOrigin.clientMetadata
              : undefined,
        },
      });
    }
    for (const item of snapshot.queue) {
      if (item.meta?.tracked !== true) continue;
      ops.push({
        op: 'prompt.upsert',
        prompt: {
          promptId: item.meta?.promptId ?? '',
          status: 'queued',
          userMessageId: item.meta?.userMessageId ?? '',
          content: projectPromptContentParts(item.message.content),
          createdAt: item.meta?.createdAt ?? '',
          clientMetadata: (item.meta?.origin as UserPromptOrigin | undefined)?.clientMetadata,
        },
      });
    }
    return ops;
  }

  private async rebuildAfterUndo(sessionId: string, agentId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    entry.undoGenerations.set(agentId, (entry.undoGenerations.get(agentId) ?? 0) + 1);
    const key = `${sessionId}:${agentId}`;
    const pending = this.healTimers.get(key);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.healTimers.delete(key);
    }
    await entry.ready;
    await entry.agentBackfills.get(agentId);
    let snapshot: AgentTranscriptSnapshot | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        snapshot = await this.readColdSnapshot(sessionId, agentId);
        if (snapshot !== undefined) break;
      } catch (error) {
        this.deps.logger?.warn(
          { sessionId, agentId, err: error instanceof Error ? error.message : error },
          'transcript: undo history read failed',
        );
      }
    }
    if (snapshot === undefined) {
      const agent = getLiveSessionById(this.deps.core.accessor, sessionId)
        ?.accessor.get(IAgentLifecycleService)
        .handleOf(agentId);
      if (agent !== undefined) {
        const current = entry.store.ensureAgent(agentId).snapshot();
        const retained = groupMessagesIntoSnapshot(
          agent.accessor.get(IAgentContextMemoryService).get(),
        );
        snapshot = {
          ...current,
          items: retained.items,
          attachments: retained.attachments,
          prompts: [],
        };
      }
    }
    if (snapshot === undefined || this.live.get(sessionId) !== entry) return;
    const ops: TranscriptOperation[] = [{ op: 'reset', agentId, snapshot }];
    entry.store.ensureAgent(agentId).apply(ops);
    this.dispatchOps(sessionId, { agentId, ops });
  }

  private async healEndedTurns(
    sessionId: string,
    agentId: string,
    ordinals: ReadonlySet<number>,
  ): Promise<void> {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    const generation = entry.undoGenerations.get(agentId) ?? 0;
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readColdSnapshot(sessionId, agentId);
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: post-turn heal failed, continuing without it',
      );
      return;
    }
    if (snapshot === undefined || this.live.get(sessionId)?.store !== entry.store) return;
    if ((entry.undoGenerations.get(agentId) ?? 0) !== generation) return;
    const transcript = entry.store.getAgent(agentId);
    if (transcript === undefined) return;
    const turnOps: TranscriptOperation[] = [];
    for (const item of snapshot.items) {
      if (item.kind !== 'turn' || !ordinals.has(item.ordinal)) continue;
      turnOps.push(...healTurnOps(item, transcript.getTurn(item.turnId)));
    }
    if (turnOps.length === 0) return;
    const superseded = supersededColdAttachmentIds(snapshot, transcript);
    const ops: TranscriptOperation[] = [
      ...snapshot.attachments
        .filter((attachment) => !superseded.has(attachment.attachmentId))
        .map((attachment) => ({
          op: 'attachment.upsert' as const,
          attachment,
        })),
      ...turnOps,
    ];
    transcript.apply(ops);
    this.dispatchOps(sessionId, { agentId, ops });
  }

  async readColdRoster(sessionId: string): Promise<AgentDescriptor[] | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    let meta: SessionMeta;
    try {
      const raw = await readFile(
        join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE),
        'utf-8',
      );
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      return [];
    }
    return Object.entries(meta.agents ?? {}).map(([agentId, agentMeta]) =>
      descriptorFromMeta(agentId, agentMeta),
    );
  }

  async readColdSnapshot(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    if (!isPlainAgentId(agentId)) {
      return groupMessagesIntoSnapshot([]);
    }
    const liveAgents = getLiveSessionById(this.deps.core.accessor, sessionId)?.accessor.get(
      IAgentLifecycleService,
    );
    await this.drainLiveWire(liveAgents, sessionId, agentId);
    let folded: AgentTranscriptSnapshot;
    try {
      folded = await this.projections.readColdSnapshot({
        sessionId,
        agentId,
        workspaceId: summary.workspaceId,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return groupMessagesIntoSnapshot([]);
      }
      throw error;
    }
    const status = liveAgents?.handleOf(agentId)?.accessor.get(IAgentLoopService).snapshot();
    return {
      ...folded,
      tasks: markLostSubagentTasks(
        folded,
        status?.state === 'running',
        (memberId) =>
          liveAgents?.handleOf(memberId)?.accessor.get(IAgentLoopService).snapshot().state ===
          'running',
      ),
    };
  }

  private async drainLiveWire(
    agents: IAgentLifecycleService | undefined,
    sessionId: string,
    agentId: string,
  ): Promise<void> {
    const wire = agents?.handleOf(agentId)?.accessor.get(IWireService);
    if (wire === undefined) return;
    try {
      await wire.flush();
    } catch (error) {
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: draining the live wire before a cold read failed',
      );
    }
  }

  dropSession(sessionId: string): void {
    this.projections.dropSession(sessionId);
    this.opsListeners.delete(sessionId);
    for (const [key, pending] of this.healTimers) {
      if (key.startsWith(`${sessionId}:`)) {
        clearTimeout(pending.timer);
        this.healTimers.delete(key);
      }
    }
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    this.live.delete(sessionId);
    entry.binding.dispose();
  }
}

export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === 'marker'
          ? { op: 'marker.upsert', item, beforeTurn }
          : { op: 'taskref.upsert', item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const attachment of snapshot.attachments) {
    ops.push({ op: 'attachment.upsert', attachment });
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  return ops;
}

export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: 'turn.upsert', turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}

const TURN_HEAL_DEBOUNCE_MS = 250;
const TURN_HEAL_MAX_DELAY_MS = 2000;
const TERMINAL_TURN_STATES: ReadonlySet<TranscriptTurn['state']> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function memberTurnOrdinals(snapshot: AgentTranscriptSnapshot): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool') continue;
        for (const ref of frame.agentRefs ?? []) ordinals.set(ref.agentId, item.ordinal);
      }
    }
  }
  return ordinals;
}

function latestTurnOrdinal(snapshot: AgentTranscriptSnapshot): number | undefined {
  let latest: number | undefined;
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    if (latest === undefined || item.ordinal > latest) latest = item.ordinal;
  }
  return latest;
}

function markLostSubagentTasks(
  snapshot: AgentTranscriptSnapshot,
  ownerTurnRunning: boolean,
  isMemberRunning: (memberId: string) => boolean,
): readonly TranscriptTask[] {
  const ordinals = memberTurnOrdinals(snapshot);
  const latest = latestTurnOrdinal(snapshot);
  const interrupted = (task: TranscriptTask): boolean => {
    if (task.kind !== 'subagent' || task.detached || task.state !== 'running') return false;
    if (task.agentId !== undefined && isMemberRunning(task.agentId)) return false;
    if (!ownerTurnRunning) return true;
    const owner = task.agentId === undefined ? undefined : ordinals.get(task.agentId);
    return owner !== undefined && owner !== latest;
  };
  return snapshot.tasks.map((task) =>
    interrupted(task) ? { ...task, state: 'lost' as const } : task,
  );
}

function supersededColdAttachmentIds(
  snapshot: AgentTranscriptSnapshot,
  transcript: AgentTranscript,
): ReadonlySet<string> {
  const superseded = new Set<string>();
  for (const item of snapshot.items) {
    if (item.kind !== 'turn' || item.attachmentIds === undefined) continue;
    const live = transcript.getTurn(item.turnId);
    if (live?.attachmentIds === undefined || live.attachmentIds.length === 0) continue;
    for (const id of item.attachmentIds) superseded.add(id);
  }
  return superseded;
}

export function healTurnOps(
  snapshotTurn: TranscriptTurn,
  liveTurn: TranscriptTurn | undefined,
): TranscriptOperation[] {
  const { steps, ...header } = snapshotTurn;
  const ops: TranscriptOperation[] = [];
  if (liveTurn === undefined) {
    ops.push({ op: 'turn.upsert', turn: header });
    for (const step of steps) {
      const { frames, ...stepHeader } = step;
      ops.push({ op: 'step.upsert', turnId: snapshotTurn.turnId, step: stepHeader });
      for (const frame of frames) {
        ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
      }
    }
    return ops;
  }
  ops.push({
    op: 'turn.upsert',
    turn: {
      ...header,
      state: liveTurn.state,
      triggerPromptId: liveTurn.triggerPromptId ?? header.triggerPromptId,
      prompt: liveTurn.prompt ?? header.prompt,
      attachmentIds: liveTurn.attachmentIds ?? header.attachmentIds,
      startedAt: liveTurn.startedAt ?? header.startedAt,
      endedAt: liveTurn.endedAt ?? header.endedAt,
    },
  });
  for (const step of steps) {
    const liveStep = liveTurn.steps.find((entry) => entry.stepId === step.stepId);
    const { frames, ...stepHeader } = step;
    if (liveStep === undefined) {
      ops.push({ op: 'step.upsert', turnId: snapshotTurn.turnId, step: stepHeader });
      for (const frame of frames) {
        ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
      }
      continue;
    }
    for (const frame of frames) {
      const liveFrame = liveStep.frames.find((entry) => entry.frameId === frame.frameId);
      if (frame.kind === 'tool') {
        const liveTool = liveFrame?.kind === 'tool' ? liveFrame : undefined;
        const liveHasOutcome =
          liveTool !== undefined && (liveTool.output !== undefined || liveTool.error !== undefined);
        const snapshotHasOutcome = frame.output !== undefined || frame.error !== undefined;
        if (liveTool !== undefined && (liveHasOutcome || !snapshotHasOutcome)) continue;
        ops.push({
          op: 'frame.upsert',
          turnId: snapshotTurn.turnId,
          stepId: step.stepId,
          frame:
            liveTool === undefined
              ? frame
              : {
                  ...frame,
                  display: liveTool.display ?? frame.display,
                  agentRefs: liveTool.agentRefs ?? frame.agentRefs,
                  approvalId: liveTool.approvalId ?? frame.approvalId,
                },
        });
        continue;
      }
      if (frame.kind !== 'text' && frame.kind !== 'thinking') continue;
      if (
        liveFrame !== undefined &&
        liveFrame.kind === frame.kind &&
        (liveFrame.kind === 'text' || liveFrame.kind === 'thinking') &&
        liveFrame.text.length >= frame.text.length
      ) {
        continue;
      }
      ops.push({ op: 'frame.upsert', turnId: snapshotTurn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}
