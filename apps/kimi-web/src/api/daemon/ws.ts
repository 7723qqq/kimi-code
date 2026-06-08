// apps/kimi-web/src/api/daemon/ws.ts
// DaemonEventSocket — browser WebSocket client for the daemon WS protocol.
// Handles: server_hello / client_hello handshake, subscribe/unsubscribe,
// ping/pong heartbeat, resync_required, error frames, event.* dispatch.

import { classifyFrame } from './agentEventProjector';
import type { WireEvent, WireServerFrame } from './wire';

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export interface DaemonEventSocketHandlers {
  /** Called for every event.* frame received */
  onWireEvent(event: WireEvent): void;
  /**
   * Called for raw agent-core frames (type does NOT start with "event." and
   * is not a control frame).  The full parsed frame object is passed so the
   * caller can extract type / seq / session_id / timestamp / payload.
   */
  onRawAgentEvent?(frame: { type: string; seq: number; session_id: string; timestamp: string; payload: unknown }): void;
  /** Called when server says client is out of sync for a session */
  onResync(sessionId: string, currentSeq: number): void;
  /** Called when the WS connection opens or closes */
  onConnectionState(connected: boolean): void;
  /** Called on error frames or JSON parse failures */
  onError(code: number, msg: string, fatal: boolean): void;
}

// ---------------------------------------------------------------------------
// DaemonEventSocket
// ---------------------------------------------------------------------------

interface PendingSubscription {
  sessionId: string;
  lastSeq: number;
}

export class DaemonEventSocket {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;

  /** subscriptions we manage: sessionId → last known seq */
  private readonly subscriptions = new Map<string, number>();

  /** subscriptions queued while not yet connected */
  private readonly pendingSubscriptions: PendingSubscription[] = [];

  private msgSeq = 0;

  constructor(
    private readonly wsUrl: string,
    private readonly clientId: string,
    private readonly handlers: DaemonEventSocketHandlers,
  ) {}

  /** Open the WebSocket connection. Safe to call once. */
  connect(): void {
    if (this.ws !== null || this.closed) return;

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      // Don't mark as connected yet — wait for server_hello
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(String(ev.data)) as WireServerFrame;
        this.handleFrame(frame);
      } catch (err) {
        this.handlers.onError(0, `Failed to parse WS frame: ${String(err)}`, false);
      }
    };

    ws.onerror = () => {
      // The error details are not exposed by the browser WS API; the close
      // event with a reason code follows immediately.
      this.handlers.onError(0, 'WebSocket error', false);
    };

    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.handlers.onConnectionState(false);
    };
  }

  /**
   * Subscribe to events for a session.
   * If connected, sends immediately; otherwise queues until after server_hello.
   */
  subscribe(sessionId: string, lastSeq = 0): void {
    this.subscriptions.set(sessionId, lastSeq);

    if (this.connected) {
      this.sendSubscribe([sessionId], { [sessionId]: lastSeq });
    } else {
      // Remove any earlier pending entry for this session, then enqueue
      const idx = this.pendingSubscriptions.findIndex((p) => p.sessionId === sessionId);
      if (idx !== -1) this.pendingSubscriptions.splice(idx, 1);
      this.pendingSubscriptions.push({ sessionId, lastSeq });
    }
  }

  /** Unsubscribe from a session's events. */
  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    if (this.connected && this.ws) {
      this.send({
        type: 'unsubscribe',
        id: this.nextId(),
        payload: { session_ids: [sessionId] },
      });
    }
  }

  /**
   * Send a WS abort control message for a prompt.
   * (The REST :abort endpoint is the primary path; this is the WS path per spec.)
   */
  abort(sessionId: string, promptId: string): void {
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'abort',
      id: this.nextId(),
      payload: { session_id: sessionId, prompt_id: promptId },
    });
  }

  /** Close the socket. Stops reconnect attempts. */
  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleFrame(rawFrame: WireServerFrame): void {
    // WireServerFrame union contains WireAck (payload: unknown) which prevents
    // TypeScript from narrowing .payload in each case arm. Cast once here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frame = rawFrame as any;
    switch ((rawFrame as { type: string }).type) {
      case 'server_hello':
        this.onServerHello();
        break;

      case 'ping':
        this.send({ type: 'pong', payload: { nonce: frame.payload.nonce } });
        break;

      case 'resync_required':
        this.handlers.onResync(frame.payload.session_id, frame.payload.current_seq);
        break;

      case 'error': {
        // A session-scoped error (has top-level session_id) is a real agent-core
        // 'error' event — e.g. a 403 from the model provider — whose message
        // must surface in the conversation. A connection-level control error
        // (no session_id) goes to onError.
        const sid = (frame as { session_id?: unknown }).session_id;
        if (typeof sid === 'string' && this.handlers.onRawAgentEvent) {
          this.handlers.onRawAgentEvent({
            type: 'error',
            seq: frame.seq,
            session_id: sid,
            timestamp: frame.timestamp,
            payload: frame.payload,
          });
        } else {
          this.handlers.onError(frame.payload.code, frame.payload.msg, frame.payload.fatal);
        }
        break;
      }

      case 'ack':
        // ack frames are fire-and-forget for now (no request tracking)
        break;

      default: {
        // Classify the frame into protocol vs agent-core. Robust to all three
        // shapes: raw agent-core, "event."-prefixed agent-core, and genuine
        // projected "event.*" protocol events. See classifyFrame() for rules.
        const type = (frame as { type: string }).type;
        const decision = classifyFrame(type, (frame as { payload?: unknown }).payload);

        if (decision.route === 'protocol') {
          // Genuine projected protocol event → existing toAppEvent() path.
          this.handlers.onWireEvent(frame as unknown as WireEvent);
          break;
        }

        if (decision.route === 'agent') {
          // Raw (or prefix-stripped) agent-core event → client-side projector.
          // We pass the prefix-stripped agentType so the projector matches its
          // raw case arms regardless of whether the wire frame carried "event.".
          if (
            this.handlers.onRawAgentEvent &&
            typeof (frame as { session_id?: unknown }).session_id === 'string'
          ) {
            const f = frame as {
              seq: number;
              session_id: string;
              timestamp: string;
              payload: unknown;
            };
            this.handlers.onRawAgentEvent({
              type: decision.agentType,
              seq: f.seq,
              session_id: f.session_id,
              timestamp: f.timestamp,
              payload: f.payload,
            });
          }
          break;
        }

        // decision.route === 'ignore' (control-shaped or unroutable) → drop.
        break;
      }
    }
  }

  private onServerHello(): void {
    this.connected = true;
    this.handlers.onConnectionState(true);

    // Build the initial subscription list from current subscriptions + pending
    const allSessionIds = Array.from(this.subscriptions.keys());
    // Drain pending: merge into subscriptions map (pending overrides if seq differs)
    for (const p of this.pendingSubscriptions) {
      this.subscriptions.set(p.sessionId, p.lastSeq);
      if (!allSessionIds.includes(p.sessionId)) allSessionIds.push(p.sessionId);
    }
    this.pendingSubscriptions.length = 0;

    // Build last_seq_by_session from subscriptions
    const lastSeqBySession: Record<string, number> = {};
    for (const [sid, seq] of this.subscriptions.entries()) {
      lastSeqBySession[sid] = seq;
    }

    this.send({
      type: 'client_hello',
      id: this.nextId(),
      payload: {
        client_id: this.clientId,
        subscriptions: allSessionIds,
        last_seq_by_session: lastSeqBySession,
      },
    });
  }

  private sendSubscribe(sessionIds: string[], lastSeqBySession: Record<string, number>): void {
    this.send({
      type: 'subscribe',
      id: this.nextId(),
      payload: {
        session_ids: sessionIds,
        last_seq_by_session: lastSeqBySession,
      },
    });
  }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // Ignore send errors (socket closing races)
    }
  }

  private nextId(): string {
    return `c_${++this.msgSeq}`;
  }
}
