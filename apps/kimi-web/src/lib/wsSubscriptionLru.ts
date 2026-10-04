export interface WsSubscriptionLruOptions {
  readonly max: number;
  isActive(sessionId: string): boolean;
  unsubscribe(sessionId: string): void;
  onEvict(sessionId: string): void;
}

export interface WsSubscriptionLru {
  retain(sessionId: string): void;
  drop(sessionId: string): void;
}

/** MRU-capped WS subscription set: keeps only the `max` most-recently-opened
    sessions subscribed. Every opened session subscribes to its WS event stream,
    and the socket keeps subscriptions across reconnects (re-sending them in
    `client_hello`). Without a cap, a user who has opened hundreds of sessions
    stays subscribed to all of them: every background session's status/meta/usage
    event then flows through the reducer and dirties the sidebar computeds — the
    root cause of "the UI gets sluggish once I have a lot of sessions".

    Eviction drops the live WS subscription but keeps the session's cursor so a
    quick re-open can resume cheaply. However, a cursor kept across an eviction
    can go stale: some session events (`event.session.status_changed`,
    `session.meta.updated`, ...) are broadcast to EVERY connection (see
    `isGlobalSessionEvent` on the server) and still advance `lastSeqBySession`
    for an unsubscribed session. If a session emits per-session durable events
    while evicted and then a global event, the cursor jumps past the missed
    events. Evictions are therefore reported through `onEvict` so the caller can
    track stale cursors and rebuild from a snapshot on re-open. */
export function createWsSubscriptionLru(options: WsSubscriptionLruOptions): WsSubscriptionLru {
  const order: string[] = [];
  const { max } = options;
  const { isActive, unsubscribe, onEvict } = options as {
    isActive: (sessionId: string) => boolean;
    unsubscribe: (sessionId: string) => void;
    onEvict: (sessionId: string) => void;
  };
  return {
    retain(sessionId: string): void {
      const idx = order.indexOf(sessionId);
      if (idx !== -1) order.splice(idx, 1);
      order.unshift(sessionId);
      // Evict the oldest entries past the cap, skipping the active session. The
      // active session is NOT guaranteed to sit at the front: first-time opens
      // only retain after an awaited snapshot, so rapid clicks can complete out
      // of order and leave the active session at the tail. Skipping it (rather
      // than breaking when the tail is active) keeps the cap effective.
      while (order.length > max) {
        let victimIdx = -1;
        for (let i = order.length - 1; i >= 0; i--) {
          if (!isActive(order[i]!)) {
            victimIdx = i;
            break;
          }
        }
        if (victimIdx === -1) break;
        const [victim] = order.splice(victimIdx, 1);
        if (victim === undefined) break;
        unsubscribe(victim);
        onEvict(victim);
      }
    },
    drop(sessionId: string): void {
      const idx = order.indexOf(sessionId);
      if (idx !== -1) order.splice(idx, 1);
    },
  };
}