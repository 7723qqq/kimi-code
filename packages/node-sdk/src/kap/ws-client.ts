import type { Event } from '@moonshot-ai/agent-core';
import {
  serverHelloPayloadSchema,
  type SessionCursor,
} from '@moonshot-ai/protocol';
import type { z } from 'zod';

import type { KapTransportOptions } from './types';

type ServerHelloPayload = z.infer<typeof serverHelloPayloadSchema>;

export interface KapWsEventHandlers {
  /** Regular durable/volatile event → SDKRpcClientBase.receiveEvent. */
  readonly onEvent: (event: Event) => void;
  /** Phase 5: approval/question request frames. Optional until Phase 5 wires them. */
  readonly onReverseRequest?: (frame: { type: string; sessionId: string; payload: unknown }) => void;
  readonly onConnectionChange?: (connected: boolean) => void;
}

interface WsFrame {
  readonly type: string;
  readonly id?: string;
  readonly seq?: number;
  readonly epoch?: string;
  readonly session_id?: string;
  readonly payload?: unknown;
}

export class KapWsClient {
  private readonly url: string;
  private readonly clientId: string;
  private readonly factory: (url: string) => WebSocket;
  private readonly handlers: KapWsEventHandlers;
  private socket: WebSocket | undefined;
  private readonly cursors = new Map<string, SessionCursor>();
  private readonly subscriptions = new Set<string>();
  private readonly pendingAcks = new Map<string, (payload: unknown) => void>();
  private ackSeq = 0;
  private closed = false;

  constructor(options: KapTransportOptions, handlers: KapWsEventHandlers) {
    this.url = options.serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/v1/ws';
    this.clientId = options.clientId ?? `sdk-${Math.random().toString(36).slice(2, 10)}`;
    this.factory = options.webSocketFactory ?? ((u) => new WebSocket(u));
    this.handlers = handlers;
  }

  async connect(): Promise<void> {
    if (this.socket !== undefined) return;
    const socket = this.factory(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve();
      }, { once: true });
      socket.addEventListener('error', (err) => {
        reject(err);
      }, { once: true });
    });
    socket.addEventListener('message', (event) => {
      this.onMessage(String(event.data));
    });
    socket.addEventListener('close', () => {
      this.onClose();
    });
  }

  async subscribe(sessionId: string): Promise<void> {
    this.subscriptions.add(sessionId);
    const cursor = this.cursors.get(sessionId);
    await this.sendControl('subscribe', {
      session_ids: [sessionId],
      ...(cursor !== undefined ? { cursors: { [sessionId]: cursor } } : {}),
    });
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.subscriptions.delete(sessionId);
    await this.sendControl('unsubscribe', { session_ids: [sessionId] });
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = undefined;
  }

  // -- internals --

  private onMessage(raw: string): void {
    const frame = JSON.parse(raw) as WsFrame;
    switch (frame.type) {
      case 'server_hello': {
        const hello = frame.payload as ServerHelloPayload;
        void this.sendControl('client_hello', {
          client_id: this.clientId,
          subscriptions: [...this.subscriptions],
        });
        void hello; // heartbeat_ms etc. available if needed
        return;
      }
      case 'ping': {
        this.send({ type: 'pong', payload: { nonce: (frame.payload as { nonce: string }).nonce } });
        return;
      }
      case 'ack': {
        const resolve = this.pendingAcks.get(frame.id ?? '');
        if (resolve !== undefined) {
          this.pendingAcks.delete(frame.id ?? '');
          resolve(frame.payload);
        }
        return;
      }
      case 'resync_required': {
        // Phase 4: treat resync as "re-subscribe from scratch" for this session.
        // Full snapshot-based resync is refined in a later hardening pass.
        const sid = frame.session_id;
        if (sid !== undefined) {
          this.cursors.delete(sid);
          void this.subscribe(sid);
        }
        return;
      }
      case 'event.approval.requested':
      case 'event.question.requested': {
        this.handlers.onReverseRequest?.({
          type: frame.type,
          sessionId: frame.session_id ?? '',
          payload: frame.payload,
        });
        return;
      }
      default: {
        // Regular business event: the envelope payload IS the Event.
        if (frame.payload !== undefined) {
          const event = frame.payload as Event;
          if (frame.seq !== undefined && frame.session_id !== undefined && !('volatile' in frame)) {
            this.cursors.set(frame.session_id, { seq: frame.seq, ...(frame.epoch !== undefined ? { epoch: frame.epoch } : {}) });
          }
          this.handlers.onEvent(event);
        }
      }
    }
  }

  private onClose(): void {
    this.socket = undefined;
    this.handlers.onConnectionChange?.(false);
    if (!this.closed) {
      // Naive reconnect; refine with backoff in hardening pass.
      setTimeout(() => void this.reconnect(), 500);
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
      for (const sid of this.subscriptions) {
        await this.subscribe(sid);
      }
      this.handlers.onConnectionChange?.(true);
    } catch {
      setTimeout(() => void this.reconnect(), 1000);
    }
  }

  private sendControl(type: string, payload: unknown): Promise<unknown> {
    const id = `a${++this.ackSeq}`;
    this.send({ type, id, payload });
    return new Promise((resolve) => {
      this.pendingAcks.set(id, resolve);
    });
  }

  private send(frame: WsFrame): void {
    this.socket?.send(JSON.stringify(frame));
  }
}
