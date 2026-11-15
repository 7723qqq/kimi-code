import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';
import { detachGrades, type TranscriptGradeSpec } from '@moonshot-ai/transcript';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import { SYSTEM_CLOCK, type Clock, type TimerHandle } from '../../../lib/clock';
import { ErrorCode } from '../../../protocol/error-codes';
import { subscribeMessageSchema, unsubscribeMessageSchema } from '../../../protocol/ws-control';
import { mapError } from '../../errors';
import type { IConnectionRegistry } from '../connectionRegistry';
import { buildPing, buildResponse } from './protocol';
import {
  type AgentFilter,
  type BroadcastDelivery,
  type BroadcastFrame,
  type BroadcastLogger,
  type BroadcastTarget,
  type SessionEventBroadcaster,
  type TargetSubscription,
} from './sessionEventBroadcaster';
import { TaskRequests, type TaskSource } from './taskRequests';

const COMMAND_TYPES: ReadonlySet<string> = new Set([
  'subscribe',
  'unsubscribe',
  'task.watch',
  'task.unwatch',
  'task.stop',
  'task.background',
]);

const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_MISS_LIMIT = 2;
const HEARTBEAT_STALL_FACTOR = 1.25;

type SessionSubscription = TargetSubscription & { conversationAgents?: readonly string[] };

function detachConversationAgents(
  existing: SessionSubscription,
  removed: readonly string[],
): readonly string[] | undefined {
  const current = existing.conversationAgents;
  if (current === undefined) return undefined;
  const gone = new Set(removed);
  const next = current.filter((agentId) => !gone.has(agentId));
  return next.length === 0 ? undefined : next;
}

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_HIGH_WATER_MARK_BYTES = 1 << 20;
const DEFAULT_BACKPRESSURE_RETRY_MS = 5;
const DEFAULT_BACKPRESSURE_MAX_DELAY_MS = 100;

interface InboundFrame {
  type: string;
  request_id?: unknown;
}

export interface WsConnectionV1Options {
  readonly socket: WebSocket;
  readonly broadcaster: SessionEventBroadcaster;
  readonly taskSource: TaskSource;
  readonly connectionRegistry: IConnectionRegistry;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;
  readonly logger?: BroadcastLogger;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly highWaterMarkBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly clock?: Clock;
}

export class WsConnectionV1 implements BroadcastTarget {
  readonly id: string;
  readonly connectedAt: string;
  readonly remoteAddress: string | null;
  readonly userAgent: string | null;

  private readonly socket: WebSocket;
  private readonly broadcaster: SessionEventBroadcaster;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly highWaterMarkBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly taskRequests: TaskRequests;
  private readonly logger?: BroadcastLogger;
  private readonly clock: Clock;

  private closed = false;
  readonly subscriptions = new Map<string, SessionSubscription>();
  private controlQueue: Promise<void> = Promise.resolve();

  private outbound: unknown[] = [];
  private flushTimer?: TimerHandle;
  private backpressureRetryTimer?: TimerHandle;
  private backpressureSince?: number;

  private heartbeatTimer?: TimerHandle;
  private lastHeartbeatAt: number;
  private lastInboundAt: number;

  constructor(opts: WsConnectionV1Options) {
    this.clock = opts.clock ?? SYSTEM_CLOCK;
    this.lastHeartbeatAt = this.clock.monotonicNow();
    this.lastInboundAt = this.clock.monotonicNow();
    this.id = `conn_${ulid()}`;
    this.connectedAt = new Date(this.clock.now()).toISOString();
    this.remoteAddress = opts.remoteAddress;
    this.userAgent = opts.userAgent;
    this.socket = opts.socket;
    this.broadcaster = opts.broadcaster;
    this.logger = opts.logger;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.highWaterMarkBytes = opts.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.taskRequests = new TaskRequests(opts.taskSource, {
      respond: (requestId, code, msg, task) => {
        this.sendImmediateFrame(buildResponse(requestId, code, msg, task));
      },
      output: (frame) => {
        this.sendSubscribedFrame(frame);
      },
    });

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    opts.connectionRegistry.add(this);
    this.broadcaster.addGlobalTarget(this);
    this.heartbeatTimer = this.clock.setInterval(() => {
      this.onHeartbeat();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  get subscriptionSessionIds(): readonly string[] {
    return Array.from(this.subscriptions.keys()).toSorted();
  }

  send(frame: BroadcastFrame, delivery: BroadcastDelivery = 'subscription'): void {
    if (delivery === 'immediate') this.sendImmediateFrame(frame);
    else this.sendSubscribedFrame(frame);
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    let frame: InboundFrame;
    try {
      frame = JSON.parse(rawDataToString(data)) as InboundFrame;
    } catch {
      return;
    }
    if (typeof frame?.type !== 'string') return;
    this.lastInboundAt = this.clock.monotonicNow();

    if (frame.type === 'pong' || !COMMAND_TYPES.has(frame.type)) return;
    const requestId = frame.request_id;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      this.close(1008, 'invalid message');
      return;
    }
    if (frame.type === 'subscribe') {
      this.enqueueControl(requestId, () => this.onSubscribe(requestId, frame));
    } else if (frame.type === 'unsubscribe') {
      this.enqueueControl(requestId, () => this.onUnsubscribe(requestId, frame));
    } else {
      this.taskRequests.handle(requestId, frame);
    }
  }

  private enqueueControl(frameId: string | undefined, task: () => Promise<void>): void {
    this.controlQueue = this.controlQueue.then(task).catch((error: unknown) => {
      this.logger?.error?.({ err: error, frameId }, 'ws control frame failed');
      if (frameId !== undefined && frameId.length > 0) {
        this.sendImmediateFrame(buildResponse(frameId, 1, 'internal error'));
      }
    });
  }

  private onHeartbeat(): void {
    const now = this.clock.monotonicNow();
    const sinceLastHeartbeat = now - this.lastHeartbeatAt;
    this.lastHeartbeatAt = now;
    if (!this.heartbeatExpired(now)) {
      this.sendImmediateFrame(buildPing());
      return;
    }
    if (sinceLastHeartbeat > this.heartbeatIntervalMs * HEARTBEAT_STALL_FACTOR) {
      this.lastInboundAt = now;
      this.sendImmediateFrame(buildPing());
      return;
    }
    setImmediate(() => {
      if (this.closed) return;
      if (this.heartbeatExpired(this.clock.monotonicNow())) {
        this.close(1001, 'heartbeat timeout');
        return;
      }
      this.sendImmediateFrame(buildPing());
    });
  }

  private heartbeatExpired(now: number): boolean {
    return now - this.lastInboundAt >= this.heartbeatIntervalMs * HEARTBEAT_MISS_LIMIT;
  }

  private async onSubscribe(requestId: string, frame: InboundFrame): Promise<void> {
    const parsed = subscribeMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid subscribe message');
      return;
    }
    const {
      session_id: sid,
      agent_ids: requestedAgentIds,
      transcript,
      transcript_since: transcriptSince,
    } = parsed.data;
    const agentIds =
      requestedAgentIds ??
      (transcript === undefined && transcriptSince === undefined ? [MAIN_AGENT_ID] : undefined);
    try {
      if (agentIds !== undefined) {
        const accepted: string[] = [];
        const notFound: string[] = [];
        await this.attachSession(
          sid,
          this.subscriptions.get(sid)?.agentFilter,
          this.subscriptions.get(sid)?.transcriptGrades,
          undefined,
          { accepted, notFound },
        );
        if (notFound.length > 0) {
          this.respond(requestId, ErrorCode.SESSION_NOT_FOUND, 'session not found');
          return;
        }
        const ok = await this.broadcaster.subscribeAgents(sid, this, agentIds);
        if (!ok) {
          this.broadcaster.unsubscribe(sid, this);
          this.subscriptions.delete(sid);
          this.respond(requestId, ErrorCode.SESSION_NOT_FOUND, 'session not found');
          return;
        }
        const existing = this.subscriptions.get(sid);
        this.subscriptions.set(sid, {
          agentFilter: existing?.agentFilter,
          transcriptGrades: existing?.transcriptGrades,
          conversationAgents: [...agentIds],
        });
        this.respond(requestId, ErrorCode.SUCCESS);
        this.sendPendingInteractions(accepted);
        return;
      }

      const accepted: string[] = [];
      const notFound: string[] = [];
      await this.attachSession(
        sid,
        this.subscriptions.get(sid)?.agentFilter,
        transcript,
        transcriptSince,
        { accepted, notFound },
      );
      if (notFound.length > 0) {
        this.respond(requestId, ErrorCode.SESSION_NOT_FOUND, 'session not found');
        return;
      }
      this.respond(requestId, ErrorCode.SUCCESS);
      this.sendPendingInteractions(accepted);
    } catch (error) {
      this.logger?.error?.({ err: error, frameId: requestId }, 'ws control frame failed');
      const failure = mapError(error, requestId);
      this.respond(requestId, failure.code, failure.msg);
    }
  }

  private async onUnsubscribe(requestId: string, frame: InboundFrame): Promise<void> {
    const parsed = unsubscribeMessageSchema.safeParse(frame);
    if (!parsed.success) {
      this.respond(requestId, ErrorCode.VALIDATION_FAILED, 'invalid unsubscribe message');
      return;
    }
    const sid = parsed.data.session_id;
    const agentIds = parsed.data.agent_ids;

    const existing = this.subscriptions.get(sid);
    if (existing !== undefined) {
      this.broadcaster.unsubscribeTranscript(sid, this, agentIds);
      this.broadcaster.unsubscribeAgents(sid, this, agentIds);
      const transcriptGrades =
        agentIds === undefined ? undefined : detachGrades(existing.transcriptGrades, agentIds);
      const conversationAgents =
        agentIds === undefined ? undefined : detachConversationAgents(existing, agentIds);
      if (
        agentIds === undefined ||
        (existing.agentFilter === undefined &&
          transcriptGrades === undefined &&
          conversationAgents === undefined)
      ) {
        this.broadcaster.unsubscribe(sid, this);
        this.subscriptions.delete(sid);
      } else {
        this.subscriptions.set(sid, {
          agentFilter: existing.agentFilter,
          transcriptGrades,
          conversationAgents,
        });
      }
    }

    this.respond(requestId, ErrorCode.SUCCESS);
  }

  private respond(requestId: string, code: number, msg?: string): void {
    this.sendImmediateFrame(buildResponse(requestId, code, msg));
  }

  private sendPendingInteractions(sessionIds: readonly string[]): void {
    for (const sid of sessionIds) this.broadcaster.sendPendingInteractions(sid, this);
  }

  private async attachSession(
    sid: string,
    filter: AgentFilter | undefined,
    transcriptGrades: TranscriptGradeSpec | undefined,
    transcriptSince: Record<string, number> | undefined,
    collectors: {
      accepted: string[];
      notFound?: string[];
    },
  ): Promise<void> {
    const { accepted, notFound } = collectors;
    const ok = await this.broadcaster.subscribe(sid, this, filter, transcriptGrades, {
      transcriptSince,
    });
    if (!ok) {
      notFound?.push(sid);
      return;
    }
    if (this.closed) {
      this.broadcaster.unsubscribe(sid, this);
      return;
    }
    this.subscriptions.set(sid, {
      agentFilter: filter,
      transcriptGrades,
      conversationAgents: this.subscriptions.get(sid)?.conversationAgents,
    });
    accepted.push(sid);
    await this.broadcaster.flushTranscriptSeed(sid, this);
  }

  private sendSubscribedFrame(msg: unknown): void {
    if (this.closed) return;
    this.outbound.push(msg);
    if (this.outbound.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private sendImmediateFrame(msg: unknown): void {
    if (this.closed) return;
    this.outbound.push(msg);
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private flush(force = false): void {
    if (this.flushTimer !== undefined) {
      this.clock.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.outbound.length === 0) return;
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      this.outbound = [];
      return;
    }

    if (!force && this.socket.bufferedAmount > this.highWaterMarkBytes) {
      this.deferForBackpressure();
      return;
    }
    this.backpressureSince = undefined;

    const frames = coalesceFrames(this.outbound);
    this.outbound = [];
    for (const frame of frames) {
      if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
      try {
        this.socket.send(JSON.stringify(frame));
      } catch {}
    }
  }

  private deferForBackpressure(): void {
    const now = this.clock.now();
    if (this.backpressureSince === undefined) this.backpressureSince = now;
    if (now - this.backpressureSince >= DEFAULT_BACKPRESSURE_MAX_DELAY_MS) {
      this.flush(true);
      return;
    }
    if (this.backpressureRetryTimer !== undefined) return;
    this.backpressureRetryTimer = this.clock.setTimeout(() => {
      this.backpressureRetryTimer = undefined;
      this.flush();
    }, DEFAULT_BACKPRESSURE_RETRY_MS);
    this.backpressureRetryTimer.unref?.();
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    this.flush(true);
    try {
      this.socket.close(code, reason);
    } catch {}
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer !== undefined) this.clock.clearTimeout(this.flushTimer);
    if (this.backpressureRetryTimer !== undefined) {
      this.clock.clearTimeout(this.backpressureRetryTimer);
    }
    if (this.heartbeatTimer !== undefined) this.clock.clearInterval(this.heartbeatTimer);
    this.outbound = [];
    this.taskRequests.dispose();
    this.broadcaster.removeGlobalTarget(this);
    for (const [sid, subscription] of this.subscriptions) {
      this.broadcaster.unsubscribe(sid, this);
      this.broadcaster.unsubscribeAgents(sid, this, subscription.conversationAgents);
    }
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface CoalescableDelta {
  type: 'assistant.delta' | 'thinking.delta';
  seq: number;
  volatile: true;
  offset?: number;
  session_id?: string;
  timestamp: string;
  payload: {
    agentId?: string;
    turnId?: number;
    delta: string;
    [key: string]: unknown;
  };
}

function isCoalescableDelta(frame: unknown): frame is CoalescableDelta {
  if (typeof frame !== 'object' || frame === null) return false;
  const f = frame as Record<string, unknown>;
  if (f['volatile'] !== true) return false;
  const type = f['type'];
  if (type !== 'assistant.delta' && type !== 'thinking.delta') return false;
  const payload = f['payload'];
  if (typeof payload !== 'object' || payload === null) return false;
  return typeof (payload as Record<string, unknown>)['delta'] === 'string';
}

export function coalesceFrames(frames: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const frame of frames) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      isCoalescableDelta(last) &&
      isCoalescableDelta(frame) &&
      last.type === frame.type &&
      last.session_id === frame.session_id &&
      last.payload.agentId === frame.payload.agentId &&
      last.payload.turnId === frame.payload.turnId
    ) {
      out[out.length - 1] = {
        ...last,
        payload: { ...last.payload, delta: last.payload.delta + frame.payload.delta },
      };
    } else {
      out.push(frame);
    }
  }
  return out;
}
