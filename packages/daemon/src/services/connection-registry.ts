/**
 * `IConnectionRegistry` (W5.1 / P0.15) — flat registry of live WS connections.
 *
 * The registry owns a `Map<connId, WsConnection>` and serves three roles:
 *
 *   1. Lookup by `connId` (W5+ broadcast paths and operator commands).
 *   2. Bulk close on shutdown (`closeAll(reason)`) — invoked by
 *      `WSGateway.dispose()` so connections are torn down BEFORE EventBus /
 *      brokers, ensuring no broker emits into a closed socket.
 *   3. Size accounting (test assertions + observability).
 *
 * Construction-order positioning: registered AFTER `IRestGateway` and BEFORE
 * `ISessionClientsService` / `IEventBus`. Under the reverse-construction
 * dispose chain this means the registry tears down LATER than the gateway
 * (which closes all sockets via the registry first), but EARLIER than the
 * brokers/logger. Concretely: `WSGateway.dispose() → registry.closeAll()` then
 * registry.dispose() is a no-op (registry already empty).
 *
 * `dispose()` is defensive: if WSGateway didn't run for any reason (failed
 * mid-boot) we still close any straggler connections so the daemon process
 * can exit cleanly.
 */

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';

import type { WsConnection } from '../ws/connection.js';

export interface IConnectionRegistry {
  /** Insert a freshly-handshaken connection. */
  add(conn: WsConnection): void;
  /** Remove a closed connection. Idempotent. */
  remove(connId: string): void;
  /** Look up by id. */
  get(connId: string): WsConnection | undefined;
  /** Iterate all currently-attached connections. */
  values(): Iterable<WsConnection>;
  /**
   * Close every attached connection with WS close code 1001 (going away) and
   * the given reason. Used by `WSGateway.dispose()` before brokers tear down.
   */
  closeAll(reason?: string): void;
  /** Number of currently-attached connections. */
  size(): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IConnectionRegistry = createDecorator<IConnectionRegistry>('IConnectionRegistry');

export class ConnectionRegistry extends Disposable implements IConnectionRegistry {
  private readonly _conns = new Map<string, WsConnection>();

  add(c: WsConnection): void {
    this._conns.set(c.id, c);
  }

  remove(id: string): void {
    this._conns.delete(id);
  }

  get(id: string): WsConnection | undefined {
    return this._conns.get(id);
  }

  values(): Iterable<WsConnection> {
    return this._conns.values();
  }

  closeAll(reason = 'daemon shutting down'): void {
    // Snapshot first — `close(...)` triggers the WS `'close'` listener which
    // calls `remove(...)` on this registry, mutating `_conns` mid-iteration.
    const snapshot = Array.from(this._conns.values());
    this._conns.clear();
    for (const c of snapshot) {
      try {
        c.close(1001, reason);
      } catch {
        // ignore — defensive teardown
      }
    }
  }

  size(): number {
    return this._conns.size;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // Belt-and-suspenders: WSGateway.dispose() already called closeAll().
    // Idempotent.
    this.closeAll();
    super.dispose();
  }
}
