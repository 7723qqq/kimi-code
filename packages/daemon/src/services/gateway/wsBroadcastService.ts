

import { Disposable } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';
import { IEventService } from '@moonshot-ai/services';

import { ILogService } from '@moonshot-ai/services';
import { ISessionClientsService } from './sessionClients';
import {
  DEFAULT_MAX_BUFFER_SIZE,
  IWSBroadcastService,
  type BufferedSinceResult,
} from './wsBroadcast';

import { buildEventEnvelope, type EventEnvelope } from '#/ws/protocol';

interface BufferEntry {
  seq: number;
  envelope: EventEnvelope;
}

interface SessionState {

  seq: number;

  buffer: BufferEntry[];

  oldestSeq: number;
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  readonly _serviceBrand: undefined;

  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxBufferSize: number;

  constructor(
    @IEventService eventService: IEventService,
    @ILogService private readonly logger: ILogService,
    @ISessionClientsService private readonly sessionClients: ISessionClientsService,
  ) {
    super();
    this._maxBufferSize = DEFAULT_MAX_BUFFER_SIZE;

    this._register(
      eventService.onDidPublish((event) => {
        this._onEvent(event);
      }),
    );
  }

  private _onEvent(event: Event): void {
    if (this._store.isDisposed) return;
    const sid = extractSessionId(event);
    const evType = (event as { type?: string }).type ?? '<no-type>';
    if (!sid) {
      this.logger.warn(
        { eventType: evType, eventKeys: Object.keys(event as object) },
        '[DBG wsBroadcast.onEvent] event has no session_id; dropping',
      );
      return;
    }
    const state = this._getOrCreateSession(sid);
    state.seq += 1;
    const envelope = buildEventEnvelope(state.seq, sid, event);
    state.buffer.push({ seq: state.seq, envelope });

    while (state.buffer.length > this._maxBufferSize) {
      const evicted = state.buffer.shift();
      if (evicted) state.oldestSeq = evicted.seq + 1;
    }

    const targets = Array.from(this.sessionClients.getConnections(sid));
    this.logger.info(
      { eventType: evType, sessionId: sid, seq: state.seq, targetCount: targets.length },
      '[DBG wsBroadcast.onEvent] fan-out',
    );
    for (const conn of targets) {
      conn.send(envelope);
    }
  }

  getBufferedSince(sid: string, lastSeq: number): BufferedSinceResult {
    const state = this._sessions.get(sid);
    if (!state) {
      return { events: [], resyncRequired: false, currentSeq: 0 };
    }
    if (lastSeq >= state.seq) {
      return { events: [], resyncRequired: false, currentSeq: state.seq };
    }
    if (lastSeq + 1 < state.oldestSeq) {
      return { events: [], resyncRequired: true, currentSeq: state.seq };
    }
    const events = state.buffer.filter((e) => e.seq > lastSeq);
    return { events, resyncRequired: false, currentSeq: state.seq };
  }

  currentSeq(sid: string): number {
    return this._sessions.get(sid)?.seq ?? 0;
  }

  _currentSeqForTest(sid: string): number {
    return this._sessions.get(sid)?.seq ?? 0;
  }

  _bufferLengthForTest(sid: string): number {
    return this._sessions.get(sid)?.buffer.length ?? 0;
  }

  _oldestSeqForTest(sid: string): number {
    return this._sessions.get(sid)?.oldestSeq ?? 0;
  }

  private _getOrCreateSession(sid: string): SessionState {
    let state = this._sessions.get(sid);
    if (!state) {
      state = { seq: 0, buffer: [], oldestSeq: 1 };
      this._sessions.set(sid, state);
    }
    return state;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this._sessions.clear();
    super.dispose();
  }
}

function extractSessionId(event: Event): string | undefined {
  const camel = (event as { sessionId?: unknown }).sessionId;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = (event as { session_id?: unknown }).session_id;
  if (typeof snake === 'string' && snake.length > 0) return snake;
  return undefined;
}
