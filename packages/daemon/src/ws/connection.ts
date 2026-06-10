

import type { RawData, WebSocket } from 'ws';
import { ulid } from 'ulid';

import {
  ErrorCode,
  clientControlMessageSchema,
  type AbortMessage,
  type ClientHelloMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
  type WatchFsAddMessage,
  type WatchFsRemoveMessage,
} from '@moonshot-ai/protocol';

import type { ILogService } from '@moonshot-ai/services';
import type { ISessionClientsService } from '#/services/gateway';

import {
  buildAck,
  buildPing,
  buildResyncRequired,
  buildServerHello,
  type EventEnvelope,
} from './protocol';
import { rawDataToString } from './rawData';

export interface BufferReplaySource {
  getBufferedSince(
    sessionId: string,
    lastSeq: number,
  ): {
    events: Array<{ seq: number; envelope: EventEnvelope }>;
    resyncRequired: boolean;
    currentSeq: number;
  };
}

export interface AbortHandler {
  abort(
    sessionId: string,
    promptId: string,
  ): Promise<{ aborted: boolean; at_seq?: number }>;

  currentSeq(sessionId: string): number;
}

export interface FsWatchHandler {
  add(
    sessionId: string,
    connectionId: string,
    wirePaths: readonly string[],
  ): Promise<FsWatchResult>;
  remove(
    sessionId: string,
    connectionId: string,
    wirePaths: readonly string[],
  ): Promise<FsWatchResult>;
  cleanupConnection(connectionId: string): void;
}

export type FsWatchResult =
  | { ok: true; watched_paths: string[]; current_count: number }
  | { ok: false; code: number; msg: string };

export interface WsConnectionOptions {
  socket: WebSocket;
  logger: ILogService;

  sessionClients: ISessionClientsService;

  wsBroadcast: BufferReplaySource;

  abortHandler?: AbortHandler;

  fsWatchHandler?: FsWatchHandler;

  pingIntervalMs?: number;

  pongTimeoutMs?: number;

  maxEventBufferSize?: number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;

const DEFAULT_PONG_TIMEOUT_MS = 10_000;

const DEFAULT_MAX_EVENT_BUFFER = 1000;

export class WsConnection {
  public readonly id: string;

  public readonly subscriptions = new Set<string>();

  public readonly lastSeqBySession = new Map<string, number>();

  private readonly socket: WebSocket;
  private readonly logger: ILogService;
  private readonly sessionClients: ISessionClientsService;
  private readonly wsBroadcast: BufferReplaySource;
  private readonly abortHandler: AbortHandler | undefined;
  private readonly fsWatchHandler: FsWatchHandler | undefined;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly maxEventBufferSize: number;

  private pingTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private closed = false;
  private gotClientHello = false;

  constructor(opts: WsConnectionOptions) {
    this.id = `conn_${ulid()}`;
    this.socket = opts.socket;
    this.logger = opts.logger.child({ connId: this.id });
    this.sessionClients = opts.sessionClients;
    this.wsBroadcast = opts.wsBroadcast;
    this.abortHandler = opts.abortHandler;
    this.fsWatchHandler = opts.fsWatchHandler;
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.maxEventBufferSize = opts.maxEventBufferSize ?? DEFAULT_MAX_EVENT_BUFFER;

    this.send(
      buildServerHello({
        ws_connection_id: this.id,
        heartbeat_ms: this.pingIntervalMs,
        max_event_buffer_size: this.maxEventBufferSize,
        capabilities: { event_batching: false, compression: false },
      }),
    );

    this.socket.on('message', (data) => this.onMessage(data));
    this.socket.on('close', (code, reason) => this.onClose(code, String(reason)));
    this.socket.on('error', (err) => this.logger.warn({ err: String(err) }, 'ws socket error'));

    this.startPingTimer();
  }

  private onMessage(data: RawData): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      this.logger.warn('non-json ws frame; ignoring');
      return;
    }
    const result = clientControlMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn({ issues: result.error.issues.length }, 'invalid control message');
      return;
    }
    const msg = result.data;
    switch (msg.type) {
      case 'client_hello':
        this.onClientHello(msg);
        break;
      case 'pong':
        this.onPong();
        break;
      case 'subscribe':
        this.onSubscribe(msg);
        break;
      case 'unsubscribe':
        this.onUnsubscribe(msg);
        break;
      case 'abort':
        this.onAbort(msg);
        break;
      case 'watch_fs_add':
        this.onWatchFsAdd(msg);
        break;
      case 'watch_fs_remove':
        this.onWatchFsRemove(msg);
        break;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
        this.logger.warn('unhandled control message type');
      }
    }
  }

  private onClientHello(msg: ClientHelloMessage): void {
    this.gotClientHello = true;
    const { subscriptions, last_seq_by_session } = msg.payload;
    const accepted: string[] = [];
    const resyncRequired: string[] = [];

    for (const sid of subscriptions) {
      this.subscribe(sid);
      accepted.push(sid);
    }

    if (last_seq_by_session) {
      for (const [sid, lastSeq] of Object.entries(last_seq_by_session)) {
        this.lastSeqBySession.set(sid, lastSeq);

        if (!this.subscriptions.has(sid)) {
          this.subscribe(sid);
          accepted.push(sid);
        }
        const result = this.wsBroadcast.getBufferedSince(sid, lastSeq);
        if (result.resyncRequired) {
          this.send(buildResyncRequired(sid, 'buffer_overflow', result.currentSeq));
          resyncRequired.push(sid);
        } else {
          for (const entry of result.events) {
            this.send(entry.envelope);
          }
        }
      }
    }

    this.logger.info(
      {
        acceptedCount: accepted.length,
        resyncRequiredCount: resyncRequired.length,
      },
      'client hello',
    );
    this.send(
      buildAck(msg.id, 0, 'success', {
        accepted_subscriptions: accepted,
        resync_required: resyncRequired,
      }),
    );
  }

  private onSubscribe(msg: SubscribeMessage): void {
    const { session_ids, last_seq_by_session, watch_fs } = msg.payload;
    this.logger.info(
      { sessionIds: session_ids, lastSeqBySession: last_seq_by_session, hasWatchFs: !!watch_fs },
      '[DBG ws.onSubscribe] received subscribe',
    );
    const accepted: string[] = [];
    const resyncRequired: string[] = [];

    for (const sid of session_ids) {
      this.subscribe(sid);
      accepted.push(sid);
    }

    if (last_seq_by_session) {
      for (const [sid, lastSeq] of Object.entries(last_seq_by_session)) {
        this.lastSeqBySession.set(sid, lastSeq);
        const result = this.wsBroadcast.getBufferedSince(sid, lastSeq);
        if (result.resyncRequired) {
          this.send(buildResyncRequired(sid, 'buffer_overflow', result.currentSeq));
          resyncRequired.push(sid);
        } else {
          for (const entry of result.events) {
            this.send(entry.envelope);
          }
        }
      }
    }

    if (watch_fs && this.fsWatchHandler !== undefined) {
      for (const [sid, cfg] of Object.entries(watch_fs)) {
        if (cfg.paths.length === 0) continue;
        const handler = this.fsWatchHandler;
        void handler
          .add(sid, this.id, cfg.paths)
          .then((result) => {
            if (!result.ok) {
              this.logger.warn(
                { sid, code: result.code, msg: result.msg },
                'subscribe.watch_fs add failed; client should retry via watch_fs_add',
              );
            }
          })
          .catch((err: unknown) => {
            this.logger.warn(
              { sid, err: String(err) },
              'subscribe.watch_fs add threw',
            );
          });
      }
    }

    this.send(
      buildAck(msg.id, 0, 'success', {
        accepted,
        not_found: [],
        resync_required: resyncRequired,
      }),
    );
  }

  private onUnsubscribe(msg: UnsubscribeMessage): void {
    const { session_ids } = msg.payload;
    for (const sid of session_ids) {
      this.unsubscribe(sid);

      if (this.fsWatchHandler !== undefined) {

        const handler = this.fsWatchHandler;
        void handler.remove(sid, this.id, []).catch((err: unknown) => {
          this.logger.warn(
            { sid, err: String(err) },
            'unsubscribe watch_fs drop threw',
          );
        });
      }
    }
    this.send(
      buildAck(msg.id, 0, 'success', {
        accepted: session_ids,
        not_found: [],
        resync_required: [],
      }),
    );
  }

  private onWatchFsAdd(msg: WatchFsAddMessage): void {
    if (this.fsWatchHandler === undefined) {
      this.send(
        buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'fs watch handler not wired', {}),
      );
      return;
    }
    const { session_id, paths } = msg.payload;
    const handler = this.fsWatchHandler;
    void handler
      .add(session_id, this.id, paths)
      .then((result) => {
        if (!result.ok) {
          this.send(buildAck(msg.id, result.code, result.msg, {}));
          return;
        }
        this.send(
          buildAck(msg.id, 0, 'success', {
            watched_paths: result.watched_paths,
            current_count: result.current_count,
          }),
        );
      })
      .catch((err: unknown) => {
        this.logger.warn({ err: String(err) }, 'watch_fs_add handler threw');
        this.send(
          buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'watch_fs_add failed', {}),
        );
      });
  }

  private onWatchFsRemove(msg: WatchFsRemoveMessage): void {
    if (this.fsWatchHandler === undefined) {
      this.send(
        buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'fs watch handler not wired', {}),
      );
      return;
    }
    const { session_id, paths } = msg.payload;
    const handler = this.fsWatchHandler;
    void handler
      .remove(session_id, this.id, paths)
      .then((result) => {
        if (!result.ok) {
          this.send(buildAck(msg.id, result.code, result.msg, {}));
          return;
        }
        this.send(
          buildAck(msg.id, 0, 'success', {
            watched_paths: result.watched_paths,
            current_count: result.current_count,
          }),
        );
      })
      .catch((err: unknown) => {
        this.logger.warn({ err: String(err) }, 'watch_fs_remove handler threw');
        this.send(
          buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'watch_fs_remove failed', {}),
        );
      });
  }

  private onAbort(msg: AbortMessage): void {
    const { session_id, prompt_id } = msg.payload;
    if (this.abortHandler === undefined) {
      this.send(
        buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'abort handler not wired', {}),
      );
      return;
    }
    void this.abortHandler
      .abort(session_id, prompt_id)
      .then((result) => {
        this.send(
          buildAck(msg.id, 0, 'success', {
            aborted: result.aborted,
            ...(result.at_seq !== undefined ? { at_seq: result.at_seq } : {}),
          }),
        );
      })
      .catch((err: unknown) => {
        if (
          typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'PromptAlreadyCompletedError'
        ) {
          const at_seq = this.abortHandler!.currentSeq(session_id);
          this.send(
            buildAck(msg.id, 0, 'success', { aborted: false, at_seq }),
          );
          return;
        }
        if (
          typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'PromptNotFoundError'
        ) {
          this.send(
            buildAck(msg.id, ErrorCode.PROMPT_NOT_FOUND, 'prompt not found', {}),
          );
          return;
        }
        if (
          typeof err === 'object' &&
          err !== null &&
          'name' in err &&
          (err as { name: string }).name === 'SessionNotFoundError'
        ) {
          this.send(
            buildAck(msg.id, ErrorCode.SESSION_NOT_FOUND, 'session not found', {}),
          );
          return;
        }
        this.logger.warn({ err: String(err) }, 'ws abort handler error');
        this.send(
          buildAck(msg.id, ErrorCode.INTERNAL_ERROR, 'abort failed', {}),
        );
      });
  }

  private subscribe(sid: string): void {
    if (this.subscriptions.has(sid)) return;
    this.subscriptions.add(sid);
    this.sessionClients.subscribe(this, sid);
  }

  private unsubscribe(sid: string): void {
    if (!this.subscriptions.has(sid)) return;
    this.subscriptions.delete(sid);
    this.sessionClients.unsubscribe(this, sid);
  }

  private startPingTimer(): void {
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      this.send(buildPing());

      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        if (this.closed) return;
        this.logger.warn('pong timeout — terminating socket');
        try {
          this.socket.terminate();
        } catch {

        }
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private onPong(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);

    this.sessionClients.forgetConnection(this);
    this.subscriptions.clear();

    if (this.fsWatchHandler !== undefined) {
      try {
        this.fsWatchHandler.cleanupConnection(this.id);
      } catch (err) {
        this.logger.warn(
          { err: String(err) },
          'fsWatchHandler.cleanupConnection threw',
        );
      }
    }
    this.logger.info({ code, reason, gotClientHello: this.gotClientHello }, 'connection closed');
  }

  public send(message: unknown): void {
    if (this.closed) return;
    if (this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message), (err) => {
        if (err) this.logger.warn({ err: String(err) }, 'ws send failed');
      });
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'ws send threw');
    }
  }

  public close(code = 1000, reason?: string): void {
    if (this.closed) return;
    try {
      this.socket.close(code, reason);
    } catch {

    }

  }

  public get hasClientHello(): boolean {
    return this.gotClientHello;
  }
}
