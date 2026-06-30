/**
 * `/api/v2` WebSocket connection — per-connection lifecycle.
 *
 * Multiplexes RPC `call`s and event `listen`s over one socket, carrying the
 * safety features from v1's `WsConnection` and VSCode's `ChannelServer`:
 *   - request ids + active-request table (cancel / unlisten disposes them)
 *   - heartbeat (ping / pong timeout → terminate)
 *   - schema validation (invalid frames are dropped, not fatal)
 *   - graceful cleanup on close (dispose listeners, cancel pending)
 *   - no stack traces over the wire
 */

import { timingSafeEqual } from 'node:crypto';

import { ErrorCodes, KimiError, type IDisposable, type Scope } from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';
import type { RawData, WebSocket } from 'ws';

import type { ScopeKind } from '../channel';
import { parseServiceAction } from '../channel';
import { dispatch, resolveScope } from '../dispatcher';
import { assertSerializable, mapError } from '../errors';
import { resolveEventSource } from './eventMap';
import type { CallMessage, ListenMessage, ServerMessage } from './wsProtocol';
import { clientMessageSchema } from './wsProtocol';

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface PendingEntry {
  /** Dispose the listener / drop the call result. */
  readonly cancel: () => void;
}

export interface WsConnectionOptions {
  readonly socket: WebSocket;
  readonly core: Scope;
  readonly token?: string;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

export class WsConnection {
  readonly id: string;
  private readonly socket: WebSocket;
  private readonly core: Scope;
  private readonly token?: string;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly callTimeoutMs: number;

  private closed = false;
  private gotHello = false;
  private readonly pending = new Map<string, PendingEntry>();
  private pingTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: WsConnectionOptions) {
    this.id = `conn_${ulid()}`;
    this.socket = opts.socket;
    this.core = opts.core;
    this.token = opts.token;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    this.socket.on('message', (data: RawData) => this.onMessage(data));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());

    this.startHeartbeat();
    this.send({ type: 'ready', heartbeatMs: this.pingIntervalMs });
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onMessage(data: RawData): void {
    if (this.closed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      return; // non-JSON frame — drop
    }

    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) return; // invalid frame — drop, don't tear down

    const msg = result.data;
    switch (msg.type) {
      case 'hello':
        this.onHello(msg.token);
        return;
      case 'pong':
        this.onPong();
        return;
      case 'call':
        void this.onCall(msg);
        return;
      case 'cancel':
        this.cancel(msg.id);
        return;
      case 'listen':
        this.onListen(msg);
        return;
      case 'unlisten':
        this.cancel(msg.id);
        return;
    }
  }

  private onHello(token: string | undefined): void {
    if (this.token !== undefined) {
      const ok =
        token !== undefined &&
        Buffer.from(token).length === Buffer.from(this.token).length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
      if (!ok) {
        this.send({ type: 'error', id: '', code: 40112, msg: 'unauthorized' });
        this.close();
        return;
      }
    }
    this.gotHello = true;
  }

  private async onCall(msg: CallMessage): Promise<void> {
    if (!this.gotHello) {
      this.send({ type: 'error', id: msg.id, code: 40112, msg: 'hello required' });
      return;
    }

    const parsed = parseServiceAction(msg.sa);
    if (parsed === undefined) {
      this.send({
        type: 'error',
        id: msg.id,
        code: 40001,
        msg: `expected <resource>:<action>, got '${msg.sa}'`,
      });
      return;
    }

    // Track so `cancel` can drop the result.
    let settled = false;
    const entry: PendingEntry = {
      cancel: () => {
        settled = true;
        this.pending.delete(msg.id);
      },
    };
    this.pending.set(msg.id, entry);

    try {
      const data = await withTimeoutWs(
        dispatch(this.core, msg.scope as ScopeKind, scopeParams(msg), parsed, msg.arg),
        this.callTimeoutMs,
      );
      if (settled || this.closed) return;
      this.pending.delete(msg.id);
      this.send({ type: 'result', id: msg.id, data });
    } catch (error) {
      if (settled || this.closed) return;
      this.pending.delete(msg.id);
      const env = mapError(error, msg.id);
      this.send({ type: 'error', id: msg.id, code: env.code, msg: env.msg });
    }
  }

  private async onListen(msg: ListenMessage): Promise<void> {
    if (!this.gotHello) {
      this.send({ type: 'error', id: msg.id, code: 40112, msg: 'hello required' });
      return;
    }
    if (this.pending.has(msg.id)) {
      this.send({ type: 'error', id: msg.id, code: 40001, msg: `id already in use: ${msg.id}` });
      return;
    }

    const source = resolveEventSource(msg.scope as ScopeKind, msg.event);
    if (source === undefined) {
      this.send({ type: 'error', id: msg.id, code: 40001, msg: `unknown event: ${msg.event}` });
      return;
    }

    let scope;
    try {
      scope = await resolveScope(this.core, msg.scope as ScopeKind, scopeParams(msg));
    } catch {
      scope = undefined;
    }
    if (scope === undefined) {
      this.send({
        type: 'error',
        id: msg.id,
        code: 40401,
        msg: `session ${msg.sessionId ?? ''} not found`,
      });
      return;
    }

    let disposable: IDisposable;
    try {
      disposable = source.subscribe(scope, (data) => this.sendEvent(msg.id, data));
    } catch (error) {
      const env = mapError(error, msg.id);
      this.send({ type: 'error', id: msg.id, code: env.code, msg: env.msg });
      return;
    }

    this.pending.set(msg.id, {
      cancel: () => {
        disposable.dispose();
        this.pending.delete(msg.id);
      },
    });
  }

  private cancel(id: string): void {
    const entry = this.pending.get(id);
    if (entry !== undefined) entry.cancel();
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private sendEvent(id: string, data: unknown): void {
    if (this.closed) return;
    try {
      const wire = assertSerializable(data);
      this.send({ type: 'event', id, data: wire });
    } catch {
      // Non-serializable event payload — drop, don't tear down the connection.
    }
  }

  private send(msg: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch {
      // best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.send({ type: 'ping' });
      if (this.pongTimer !== undefined) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.closed) return;
        try {
          this.socket.terminate();
        } catch {
          // ignore
        }
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private onPong(): void {
    if (this.pongTimer !== undefined) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Close
  // -------------------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    try {
      this.socket.close(1000);
    } catch {
      // ignore
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    if (this.pongTimer !== undefined) clearTimeout(this.pongTimer);
    for (const entry of this.pending.values()) {
      try {
        entry.cancel();
      } catch {
        // ignore cleanup errors
      }
    }
    this.pending.clear();
  }
}

function scopeParams(msg: { sessionId?: string; agentId?: string }): Record<string, string> {
  const params: Record<string, string> = {};
  if (msg.sessionId !== undefined) params['session_id'] = msg.sessionId;
  if (msg.agentId !== undefined) params['agent_id'] = msg.agentId;
  return params;
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function withTimeoutWs<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new KimiError(ErrorCodes.INTERNAL, `call timed out after ${ms}ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}
