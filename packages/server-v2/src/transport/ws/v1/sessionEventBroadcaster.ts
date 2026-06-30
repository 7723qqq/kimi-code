/**
 * `SessionEventBroadcaster` — per-session single fan-out point that turns
 * agent `IEventSink` emissions into a sequenced, journaled, replayable
 * `/api/v1/ws` event stream (the `{seq, epoch}` watermark).
 *
 * Port of v1's `WSBroadcastService` (`packages/server/.../wsBroadcastService.ts`),
 * adapted to v2 where agent events live on per-agent `IEventSink`s (not a Core
 * firehose). For each session it:
 *
 *   1. Subscribes to every agent's `IEventSink` via `IAgentLifecycleService`
 *      reach-down-via-handle (and `onDidCreate`/`onDidDispose` for late agents).
 *   2. Attaches `agentId`/`sessionId` to build the wire `Event`.
 *   3. Classifies durable vs volatile (`VOLATILE_EVENT_TYPES`).
 *   4. Durable events: assign the next per-session `seq` (monotonic across
 *      restarts), persist to the `SessionEventJournal`, cache in an in-memory
 *      tail, fan out.
 *   5. Volatile events: fan out live with the current durable watermark as
 *      `seq` and `volatile: true`. Never journaled, never replayed.
 *   6. Exposes replay (`getBufferedSince`) keyed by `{seq, epoch}` cursors and
 *      an atomic `getSnapshotState` for the snapshot route.
 *
 * A session is activated (journaling starts) on first `subscribe` /
 * `getSnapshotState` / `getCursor` and stays active for the process lifetime so
 * the journal is continuous from first activation onward.
 */

import type { IDisposable, IScopeHandle, Scope } from '@moonshot-ai/agent-core-v2';
import {
  IAgentLifecycleService,
  IEventSink,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import type { AgentEvent, Event, InFlightTurn, SessionCursor } from '@moonshot-ai/protocol';
import { isVolatileEventType } from '@moonshot-ai/protocol';

import { InFlightTurnTracker } from './inFlightTurnTracker';
import {
  type EventEnvelope,
  type JournalLogger,
  SessionEventJournal,
  sessionJournalPath,
} from './sessionEventJournal';

export type ResyncReason = 'buffer_overflow' | 'session_recreated' | 'epoch_changed';

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  /** When set, the client must rebuild from the snapshot and re-subscribe. */
  resyncRequired: ResyncReason | false;
  currentSeq: number;
  epoch: string;
}

export interface SessionSnapshotState {
  seq: number;
  epoch: string;
  inFlightTurn: InFlightTurn | null;
}

/** A connection (or test double) that receives sequenced envelopes. */
export interface BroadcastTarget {
  send(envelope: EventEnvelope): void;
}

interface SessionState {
  readonly sessionId: string;
  readonly journal: SessionEventJournal;
  readonly tracker: InFlightTurnTracker;
  /** Recent durable envelopes for in-memory replay. */
  readonly tail: Array<{ seq: number; envelope: EventEnvelope }>;
  /** Connections subscribed to this session. */
  readonly targets: Set<BroadcastTarget>;
  /** Per-session dispatch queue — serializes stamp / journal / fan-out. */
  queue: Promise<void>;
  /** agentId → sink subscription. */
  readonly agentDisposables: Map<string, IDisposable>;
  readonly lifecycleDisposables: IDisposable[];
}

export const DEFAULT_MAX_BUFFER_SIZE = 1000;

export class SessionEventBroadcaster {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxBufferSize: number;

  constructor(
    private readonly opts: {
      readonly eventsDir: string;
      readonly core: Scope;
      readonly logger?: JournalLogger;
      readonly maxBufferSize?: number;
    },
  ) {
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  /** Subscribe a connection to a session's stream (activates the session). */
  async subscribe(sessionId: string, target: BroadcastTarget): Promise<boolean> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return false;
    state.targets.add(target);
    return true;
  }

  unsubscribe(sessionId: string, target: BroadcastTarget): void {
    this.sessions.get(sessionId)?.targets.delete(target);
  }

  async getBufferedSince(sessionId: string, cursor: SessionCursor): Promise<BufferedSinceResult> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) {
      return { events: [], resyncRequired: 'session_recreated', currentSeq: 0, epoch: '' };
    }
    // Drain so the cursor reflects everything dispatched so far.
    await state.queue;
    const { journal, tail } = state;
    const currentSeq = journal.seq;
    const { epoch } = journal;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      // Stale / foreign cursor (e.g. from a different epoch or a pre-journal client).
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this.maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    // Serve from the memory tail when it fully covers the gap; else the journal.
    const tailStart = tail[0]?.seq;
    if (tailStart !== undefined && tailStart <= cursor.seq + 1) {
      const events = tail.filter((e) => e.seq > cursor.seq);
      return { events, resyncRequired: false, currentSeq, epoch };
    }
    const fromDisk = await journal.readSince(cursor.seq, this.maxBufferSize);
    return { events: fromDisk, resyncRequired: false, currentSeq, epoch };
  }

  async getCursor(sessionId: string): Promise<{ seq: number; epoch: string }> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return { seq: 0, epoch: '' };
    await state.queue;
    return { seq: state.journal.seq, epoch: state.journal.epoch };
  }

  /** Atomic-at-queue watermark + in-flight turn, for the snapshot route. */
  async getSnapshotState(sessionId: string): Promise<SessionSnapshotState> {
    const state = await this.ensureState(sessionId);
    if (state === undefined) return { seq: 0, epoch: '', inFlightTurn: null };
    await state.queue;
    return {
      seq: state.journal.seq,
      epoch: state.journal.epoch,
      inFlightTurn: state.tracker.get(sessionId),
    };
  }

  async close(): Promise<void> {
    for (const state of this.sessions.values()) {
      for (const d of state.lifecycleDisposables) d.dispose();
      for (const d of state.agentDisposables.values()) d.dispose();
      await state.journal.close();
    }
    this.sessions.clear();
  }

  private async ensureState(sessionId: string): Promise<SessionState | undefined> {
    let state = this.sessions.get(sessionId);
    if (state !== undefined) return state;

    const session = this.opts.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) return undefined;

    const journal = await SessionEventJournal.open(
      sessionJournalPath(this.opts.eventsDir, sessionId),
      this.opts.logger,
    );
    state = {
      sessionId,
      journal,
      tracker: new InFlightTurnTracker(),
      tail: [],
      targets: new Set(),
      queue: Promise.resolve(),
      agentDisposables: new Map(),
      lifecycleDisposables: [],
    };
    this.sessions.set(sessionId, state);
    this.attachAgents(sessionId, session, state);
    return state;
  }

  private attachAgents(sessionId: string, session: IScopeHandle, state: SessionState): void {
    const agents = session.accessor.get(IAgentLifecycleService);
    const subscribeAgent = (handle: IScopeHandle): void => {
      if (state.agentDisposables.has(handle.id)) return;
      const sink = handle.accessor.get(IEventSink);
      const d = sink.on((agentEvent) => this.onAgentEvent(sessionId, handle.id, agentEvent));
      state.agentDisposables.set(handle.id, d);
    };
    for (const handle of agents.list()) subscribeAgent(handle);
    state.lifecycleDisposables.push(
      agents.onDidCreate((handle) => subscribeAgent(handle)),
      agents.onDidDispose((agentId) => {
        const d = state.agentDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          state.agentDisposables.delete(agentId);
        }
      }),
    );
  }

  private onAgentEvent(sessionId: string, agentId: string, agentEvent: AgentEvent): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const event = { ...agentEvent, agentId, sessionId } as Event;
    // Enqueue so dispatch is serialized per session.
    state.queue = state.queue.then(() => this.dispatch(state, event)).catch(() => {});
  }

  private async dispatch(state: SessionState, event: Event): Promise<void> {
    const { journal, tracker, tail, targets, sessionId } = state;
    const annotation = tracker.apply(sessionId, event);

    let envelope: EventEnvelope;
    if (isVolatileEventType(event.type)) {
      envelope = this.buildEnvelope(journal.seq, sessionId, event, {
        epoch: journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
      });
    } else {
      const seq = journal.nextSeq();
      envelope = this.buildEnvelope(seq, sessionId, event, { epoch: journal.epoch });
      journal.append(seq, envelope);
      tail.push({ seq, envelope });
      while (tail.length > this.maxBufferSize) tail.shift();
    }

    const fanOut = isGlobalEvent(event.type) ? this.allTargets() : targets;
    for (const target of fanOut) {
      try {
        target.send(envelope);
      } catch {
        // best-effort fan-out; a broken target is dropped, not fatal
      }
    }
  }

  private buildEnvelope(
    seq: number,
    sessionId: string,
    event: Event,
    extras: { epoch?: string; volatile?: boolean; offset?: number },
  ): EventEnvelope {
    return {
      type: event.type,
      seq,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload: event,
      ...extras,
    };
  }

  private *allTargets(): Iterable<BroadcastTarget> {
    for (const state of this.sessions.values()) {
      for (const target of state.targets) yield target;
    }
  }
}

/** Session/workspace/config events are broadcast to every connection. */
function isGlobalEvent(type: string): boolean {
  return (
    type.startsWith('event.session.') ||
    type.startsWith('event.workspace.') ||
    type.startsWith('event.config.')
  );
}
