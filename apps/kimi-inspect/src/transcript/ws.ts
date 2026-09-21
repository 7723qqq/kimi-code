/**
 * Minimal `/api/v1/ws` client for the v1 transcript surface.
 *
 * Handshake per the protocol contract: on open the client sends
 * `client_hello` (the bearer token rides the `kimi-code.bearer.<token>`
 * subprotocol at the upgrade — the only credential channel a browser
 * WebSocket has), then `subscribe_v2` for one session's agent transcripts.
 * The server answers each with an `ack` (matched by `id`) and streams
 * `transcript.reset` (a baseline snapshot per agent) followed by
 * `transcript.ops` batches carrying a monotonic `seq`. Heartbeat is the
 * WS protocol-level ping/pong, handled by the WebSocket implementation.
 *
 * `transcript_since` carries the last seq this client applied for the
 * agent, so a reconnect resumes instead of restarting: the server replays
 * from the stored events at or above it. Omit it (or pass 0) for the cold
 * load, which is what the initial subscribe does.
 *
 * A drop is answered with a backoff reconnect and a fresh subscribe from
 * the held cursor — the reset is idempotent, so the consumer's only job on
 * `onAck` is to re-project.
 */
import type { AgentTranscriptSnapshot, TranscriptOpBatch } from '@moonshot-ai/transcript';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

/** A frame's optional text field, without stringifying a non-string. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The grade asked for: every op, including per-token deltas. */
const TRANSCRIPT_GRADE = 'delta';

export interface ChatWsHandlers {
  /** A `transcript.reset` baseline for one agent. */
  onReset: (agentId: string, snapshot: AgentTranscriptSnapshot) => void;
  /** A `transcript.ops` batch for one agent. */
  onOps: (batch: TranscriptOpBatch) => void;
  /** The subscribe ack (code 0 = subscribed) — fires on every (re)subscribe. */
  onAck: (code: number, msg?: string) => void;
  /** Protocol-level `error` frame (auth failure, unknown frame, slow consumer). */
  onProtocolError: (code: number, msg: string) => void;
  /** A frame that is not valid JSON, or names no known type. */
  onInvalidFrame?: (raw: unknown) => void;
  /** The socket dropped and a reconnect attempt is scheduled. */
  onReconnectScheduled?: (attempt: number) => void;
}

export interface ChatWsOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v1/ws` URL. */
  readonly url: string;
  readonly token?: string;
  readonly sessionId: string;
  /** Agents to subscribe; defaults to the session's `main` agent. */
  readonly agentIds?: readonly string[];
  /** Last applied seq per agent, for the reconnect cursor. */
  readonly since?: Readonly<Record<string, number>>;
  readonly handlers: ChatWsHandlers;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

export class ChatWs {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly sessionId: string;
  private readonly agentIds: readonly string[];
  private readonly handlers: ChatWsHandlers;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private helloId = 0;
  private subscribeId = 0;
  /** Last applied seq per agent, echoed back in `transcript_since`. */
  private since: Record<string, number>;

  constructor(opts: ChatWsOptions) {
    this.wsUrl = toWsV1Url(opts.url);
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.agentIds =
      opts.agentIds !== undefined && opts.agentIds.length > 0 ? [...opts.agentIds] : ['main'];
    this.handlers = opts.handlers;
    const ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsLikeCtor | undefined);
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WsCtor = ctor;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.since = { ...opts.since };
    this.connect();
  }

  /** Tear the socket down permanently. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  /** Force a reconnect (debug/testing): drop the socket and re-subscribe after `delayMs`. */
  reconnect(delayMs = 0): void {
    if (this.manualClose) return;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.reconnectAttempt += 1;
    this.handlers.onReconnectScheduled?.(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private connect(): void {
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WsLike;
    try {
      ws = new this.WsCtor(this.wsUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.helloId += 1;
      this.send({ kind: 'client_hello', id: `hello-${this.helloId}` });
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {});
  }

  private onMessage(raw: unknown): void {
    let frame: { type?: unknown } | null;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this.handlers.onInvalidFrame?.(raw);
      return;
    }
    const type = typeof frame?.type === 'string' ? frame.type : undefined;
    switch (type) {
      case 'server_hello':
      case 'hello': {
        this.subscribeId += 1;
        this.send({
          kind: 'subscribe_v2',
          id: `sub-${this.subscribeId}`,
          session_id: this.sessionId,
          transcript: Object.fromEntries(this.agentIds.map((agent) => [agent, TRANSCRIPT_GRADE])),
          transcript_since: Object.fromEntries(
            this.agentIds.map((agent) => [agent, this.since[agent] ?? 0]),
          ),
        });
        return;
      }
      case 'ack': {
        const ack = frame as unknown as { id?: unknown; code?: unknown; msg?: unknown };
        if (ack.id === `sub-${this.subscribeId}`) {
          this.handlers.onAck(typeof ack.code === 'number' ? ack.code : 0, textOf(ack.msg));
        }
        return;
      }
      case 'error': {
        const err = frame as unknown as { code?: unknown; msg?: unknown };
        this.handlers.onProtocolError(
          typeof err.code === 'number' ? err.code : 0,
          textOf(err.msg),
        );
        return;
      }
      // The fork's control frames are tagged `kind`, not `type`.
      case undefined: {
        const kind = (frame as { kind?: unknown } | null)?.kind;
        if (kind === 'ack') {
          const ack = frame as unknown as { id?: unknown; code?: unknown; msg?: unknown };
          if (ack.id === `sub-${this.subscribeId}`) {
            this.handlers.onAck(typeof ack.code === 'number' ? ack.code : 0, textOf(ack.msg));
          }
          return;
        }
        if (kind === 'error') {
          const err = frame as unknown as { code?: unknown; msg?: unknown };
          this.handlers.onProtocolError(
            typeof err.code === 'number' ? err.code : 0,
            textOf(err.msg),
          );
          return;
        }
        this.handlers.onInvalidFrame?.(frame);
        return;
      }
      case 'transcript.reset': {
        const payload = (frame as unknown as {
          payload?: { agent_id?: unknown; snapshot?: unknown };
        }).payload;
        const snapshot = payload?.snapshot as AgentTranscriptSnapshot | undefined;
        if (snapshot !== undefined) {
          const agentId = typeof payload?.agent_id === 'string' ? payload.agent_id : 'main';
          this.since[agentId] = 0;
          this.handlers.onReset(agentId, snapshot);
        }
        return;
      }
      case 'transcript.ops': {
        const payload = (frame as unknown as { payload?: { agent_id?: unknown; ops?: unknown; seq?: unknown } })
          .payload;
        const agentId = payload?.agent_id;
        const ops = payload?.ops;
        if (typeof agentId === 'string' && Array.isArray(ops)) {
          if (typeof payload?.seq === 'number') this.since[agentId] = payload.seq;
          this.handlers.onOps({ agentId, ops } as TranscriptOpBatch);
        }
        return;
      }
      default:
        this.handlers.onInvalidFrame?.(frame);
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    this.handlers.onReconnectScheduled?.(this.reconnectAttempt);
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== this.WsCtor.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort; the close handler handles teardown
    }
  }
}

/** Derive the `/api/v1/ws` WebSocket URL from a server base URL (or pass a full ws URL through). */
function toWsV1Url(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v1/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
