/**
 * `ISessionClientsService` (W5.2 / P0.16) — `sessionId → Set<WsConnection>`
 * reverse index.
 *
 * `IConnectionRegistry` indexes connections by `connId` (1→1 by socket).
 * `ISessionClientsService` indexes them by `sessionId` (1→N by subscription)
 * so `DaemonEventBus.publish(event)` can fan out to all live subscribers in
 * O(1) lookup + O(k) send (k = subscribers of that session).
 *
 * Why a separate service (not a method on the registry): the registry
 * doesn't know about subscriptions — those are application-level state, not
 * connection-level. Keeping them separate also lets WS subscribe/unsubscribe
 * mutations skip touching the connection map.
 *
 * Construction order: registered AFTER `IConnectionRegistry` and BEFORE
 * `IEventBus` (the event bus consumes this service). Disposes (in reverse)
 * BEFORE the connection registry — no special teardown needed because the
 * connection registry has its own `closeAll()` path.
 *
 * **Idempotency**: `subscribe(conn, sid)` is idempotent — adding the same
 * connection twice is a no-op (Set semantics). `unsubscribe` likewise.
 * `forgetConnection` drops the connection from EVERY session's set.
 */

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';

import { ILogger } from './logger.js';
import type { WsConnection } from '../ws/connection.js';

export interface ISessionClientsService {
  /** Add `connection` as a subscriber to `sessionId`. Idempotent. */
  subscribe(connection: WsConnection, sessionId: string): void;
  /** Remove a single (connection, sessionId) subscription. Idempotent. */
  unsubscribe(connection: WsConnection, sessionId: string): void;
  /** Iterate all connections subscribed to `sessionId`. */
  getConnections(sessionId: string): Iterable<WsConnection>;
  /** Remove `connection` from every session it was subscribed to. */
  forgetConnection(connection: WsConnection): void;
  /** Test helper / observability: count of subscribers for a session. */
  subscriberCount(sessionId: string): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionClientsService = createDecorator<ISessionClientsService>(
  'ISessionClientsService',
);

export class SessionClientsService extends Disposable implements ISessionClientsService {
  private readonly _bySession = new Map<string, Set<WsConnection>>();

  /**
   * P2.2: `@ILogger` is auto-injected by the container. The service does
   * not currently emit log lines (the subscription model is silent by
   * design — broker/event-bus call sites do the logging) but the dep is
   * declared so future diagnostic work doesn't need a ctor reshuffle.
   */
  constructor(@ILogger private readonly _logger: ILogger) {
    super();
    void this._logger;
  }

  subscribe(connection: WsConnection, sessionId: string): void {
    let set = this._bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this._bySession.set(sessionId, set);
    }
    set.add(connection);
  }

  unsubscribe(connection: WsConnection, sessionId: string): void {
    const set = this._bySession.get(sessionId);
    if (!set) return;
    set.delete(connection);
    // Garbage-collect the bucket when empty so `subscriberCount` stays cheap
    // and the map doesn't grow indefinitely with one-off session_ids.
    if (set.size === 0) this._bySession.delete(sessionId);
  }

  getConnections(sessionId: string): Iterable<WsConnection> {
    const set = this._bySession.get(sessionId);
    if (!set) return EMPTY_ITERABLE;
    return set.values();
  }

  forgetConnection(connection: WsConnection): void {
    // Walk every session bucket and drop the connection. Cheaper than a
    // reverse index (connId → sessionIds) for the connection counts we
    // expect (PLAN: O(10) WS clients per daemon).
    for (const [sid, set] of this._bySession) {
      if (set.delete(connection) && set.size === 0) {
        this._bySession.delete(sid);
      }
    }
  }

  subscriberCount(sessionId: string): number {
    return this._bySession.get(sessionId)?.size ?? 0;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._bySession.clear();
    super.dispose();
  }
}

const EMPTY_ITERABLE: Iterable<WsConnection> = Object.freeze({
  [Symbol.iterator]: function* (): Iterator<WsConnection> {
    // empty
  },
});
