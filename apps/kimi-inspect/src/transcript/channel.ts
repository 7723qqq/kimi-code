/**
 * Chat channel — owns the `ChatStore`, the `AuditTrail` and the
 * `/api/v1/ws` subscription for one (session, agent) pair.
 *
 * Recovery per the protocol, all of it converging through the transcript
 * op fold (no buffering, no page cursors):
 *
 *  - Initial load: the subscribe itself is the cold read. Sending
 *    `transcript_since: 0` makes the server answer with a
 *    `transcript.reset` baseline followed by the stored history as op
 *    batches, so there is no separate REST fetch to race the socket.
 *  - Reconnect: the same subscribe carrying the last applied seq per
 *    agent; the server replays from the stored events at or above it.
 *  - A reported op-seq gap (the server jumped past a batch this client
 *    never saw) is answered by resubscribing from 0 — the reset is
 *    idempotent, so the store simply rebuilds.
 */
import { AuditTrail } from '../audit/trail';
import type { WsLikeCtor } from '../channel/wsLike';
import { ChatStore } from './store';
import { ChatWs } from './ws';

export interface ChatChannelOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly WebSocketImpl?: WsLikeCtor;
  readonly reconnectDelayMs?: number;
  readonly notifyIntervalMs?: number;
  readonly onLoaded?: () => void;
  readonly onLoadError?: (error: unknown) => void;
}

export class ChatChannel {
  readonly store: ChatStore;
  readonly trail: AuditTrail;

  private readonly opts: ChatChannelOptions;
  private readonly ws: ChatWs;
  private disposed = false;

  constructor(opts: ChatChannelOptions) {
    this.opts = opts;
    this.store = new ChatStore({ notifyIntervalMs: opts.notifyIntervalMs });
    this.trail = new AuditTrail();
    this.ws = new ChatWs({
      url: opts.baseUrl,
      token: opts.token,
      sessionId: opts.sessionId,
      agentIds: [opts.agentId],
      WebSocketImpl: opts.WebSocketImpl,
      reconnectDelayMs: opts.reconnectDelayMs,
      handlers: {
        onReset: (agentId, snapshot) => {
          this.store.applyReset(agentId, snapshot);
          this.trail.recordReset(opts.agentId, snapshot, this.store.getState());
          this.trail.recordEvent('ack', undefined, this.store.getState());
          if (!this.disposed) this.opts.onLoaded?.();
        },
        onOps: (batch) => {
          const { gap } = this.store.applyBatch(batch);
          this.trail.recordOps(batch.agentId, 'live', batch, this.store.getState());
          if (gap && !this.disposed) {
            this.trail.recordEvent(
              'gap-refresh',
              `seq gap on ${batch.agentId}`,
              this.store.getState(),
            );
            this.ws.reconnect(0);
          }
        },
        onAck: (code, msg) => {
          if (code === 0) return;
          this.trail.recordEvent('ack-error', msg, this.store.getState());
          this.opts.onLoadError?.(new Error(`subscribe rejected (${code}): ${msg ?? ''}`));
        },
        onProtocolError: (code, msg) => {
          this.trail.recordEvent('protocol-error', `${code}: ${msg}`, this.store.getState());
        },
        onInvalidFrame: () => {
          this.trail.recordEvent('invalid-frame', undefined, this.store.getState());
        },
        onReconnectScheduled: () => {
          this.trail.recordEvent('reconnect', undefined, this.store.getState());
        },
      },
    });
  }

  /** The socket connects on construction; this only marks the channel live. */
  start(): void {
    this.trail.recordEvent('ack', 'subscribing', this.store.getState());
  }

  /** Force a WS reconnect (debug/testing): the ack re-triggers the replay. */
  reconnect(delayMs = 0): void {
    this.ws.reconnect(delayMs);
  }

  close(): void {
    this.disposed = true;
    this.ws.close();
    this.store.flushNotify();
  }
}
