/**
 * `IWSGateway` (W5.1 / P0.15) — WebSocket gateway.
 *
 * Owns a `ws.WebSocketServer` in `noServer` mode and attaches an `'upgrade'`
 * handler to the Fastify-exposed raw `http.Server`. WS path is `/api/v1/ws`
 * (WS.md §1.1). On upgrade we instantiate a `WsConnection`, register it in
 * `IConnectionRegistry`, and let the connection drive its own handshake +
 * heartbeat.
 *
 * **Construction order** (relative to W4 services):
 *   ILogger → IRestGateway → IConnectionRegistry → ISessionClientsService
 *     → IEventBus → IApprovalBroker → IQuestionBroker
 *     → IWSGateway   ← here, constructed LATE
 *     → IHarnessBridge
 *
 * Why late: dispose runs in REVERSE construction order. So `WSGateway.dispose()`
 * runs EARLY at shutdown, closing all WS connections via the registry BEFORE
 * EventBus / brokers tear down. If we constructed WSGateway earlier, broker
 * `.dispose()` could try to emit on a still-attached socket whose owner is
 * already gone.
 *
 * Why `noServer` mode (not `port:`): Fastify already owns the HTTP server.
 * We share it — every WS handshake passes through Fastify's listener, gets
 * intercepted by our `'upgrade'` handler, and only `/api/v1/ws` paths are
 * upgraded; other paths get an immediate `socket.destroy()` (defensive).
 *
 * `dispose()` is reverse-order safe:
 *   1. `registry.closeAll()` — sends WS code 1001 (going away) to each socket.
 *   2. `wss.close()` — stops accepting new upgrades.
 *   3. Detaches the `'upgrade'` listener from `app.server`.
 *
 * Anti-corruption: no SDK imports. WS schemas come from
 * `@moonshot-ai/protocol`.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';
import { WebSocketServer, type WebSocket } from 'ws';

import { IConnectionRegistry } from './connection-registry.js';
import type { DaemonEventBus } from './event-bus.js';
import { ILogger } from './logger.js';
import { IRestGateway } from './rest-gateway.js';
import { ISessionClientsService } from './session-clients.js';
import { WsConnection, type AbortHandler, type FsWatchHandler } from '../ws/connection.js';

/** WS endpoint path. WS.md §1.1. */
export const WS_PATH = '/api/v1/ws';

export interface IWSGateway {
  /** Number of currently-attached WS connections. */
  readonly size: number;
  /**
   * W7.3: attach an abort handler so future WS connections can dispatch
   * `abort` control messages through it. Has no effect on already-attached
   * connections (they captured their handler at construction).
   */
  setAbortHandler(handler: AbortHandler): void;
  /**
   * W12 / Chain 14: attach an fs-watch handler so future WS connections
   * can dispatch `subscribe.watch_fs` / `watch_fs_add` / `watch_fs_remove`
   * through it. Like `setAbortHandler`, only affects connections opened
   * AFTER the call; in production we wire it once at startup before the
   * REST listener accepts traffic, so this is a non-issue.
   */
  setFsWatchHandler(handler: FsWatchHandler): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSGateway = createDecorator<IWSGateway>('IWSGateway');

export interface WSGatewayOptions {
  /**
   * Override the default ping interval (30_000ms) for tests so the test can
   * observe a `ping` without sleeping 30s.
   */
  pingIntervalMs?: number;
  /** Override the default pong deadline (10_000ms). */
  pongTimeoutMs?: number;
  /** Override server_hello server_id (defaults to a fresh ULID per connection). */
  serverId?: string;
}

export class WSGateway extends Disposable implements IWSGateway {
  private readonly wss: WebSocketServer;
  private readonly upgradeListener: (req: IncomingMessage, sock: Socket, head: Buffer) => void;
  private readonly server: HttpServer;
  private abortHandler: AbortHandler | undefined;
  private fsWatchHandler: FsWatchHandler | undefined;
  private detached = false;

  constructor(
    // P2.3: VSCode-style ctor ordering — static-first, services-last with
    // `@I*` decorators. `eventBus` is kept as a non-decorated concrete
    // `DaemonEventBus` static dep because the consumer (`WsConnection`) needs
    // the daemon-specific `BufferReplaySource` shape (`getBufferedSince`,
    // `currentSeq`, `addObserver`) which the `IEventBus` interface from
    // `@moonshot-ai/services` does NOT expose. Promoting `DaemonEventBus`
    // to its own identifier is a deliberate followup (ROADMAP P2.3 note).
    // `options` must follow `eventBus` (TS forbids a required param after an
    // optional one); start.ts passes `opts.wsGatewayOptions ?? {}` explicitly,
    // so we drop the inline default — the caller always supplies a concrete
    // object.
    private readonly eventBus: DaemonEventBus,
    private readonly options: WSGatewayOptions,
    @IRestGateway private readonly restGateway: IRestGateway,
    @IConnectionRegistry private readonly registry: IConnectionRegistry,
    @ISessionClientsService private readonly sessionClients: ISessionClientsService,
    @ILogger private readonly logger: ILogger,
  ) {
    super();
    this.wss = new WebSocketServer({ noServer: true });
    this.server = this.restGateway.app.server;
    this.upgradeListener = (req, sock, head) => this.onUpgrade(req, sock, head);
    this.server.on('upgrade', this.upgradeListener);
    this.logger.debug({ path: WS_PATH }, 'ws gateway attached upgrade listener');
  }

  setAbortHandler(handler: AbortHandler): void {
    this.abortHandler = handler;
  }

  setFsWatchHandler(handler: FsWatchHandler): void {
    this.fsWatchHandler = handler;
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    // Restrict to `/api/v1/ws` (with optional query string per WS.md §1.1).
    const url = req.url ?? '';
    const path = url.split('?', 1)[0];
    if (path !== WS_PATH) {
      // Other Fastify routes don't use WS; politely drop the handshake.
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws));
  }

  private onConnect(socket: WebSocket): void {
    const conn = new WsConnection({
      socket,
      logger: this.logger,
      sessionClients: this.sessionClients,
      eventBus: this.eventBus,
      ...(this.abortHandler !== undefined ? { abortHandler: this.abortHandler } : {}),
      ...(this.fsWatchHandler !== undefined ? { fsWatchHandler: this.fsWatchHandler } : {}),
      ...(this.options.pingIntervalMs !== undefined
        ? { pingIntervalMs: this.options.pingIntervalMs }
        : {}),
      ...(this.options.pongTimeoutMs !== undefined
        ? { pongTimeoutMs: this.options.pongTimeoutMs }
        : {}),
      ...(this.options.serverId !== undefined ? { serverId: this.options.serverId } : {}),
    });
    this.registry.add(conn);
    socket.on('close', () => this.registry.remove(conn.id));
  }

  get size(): number {
    return this.registry.size();
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // 1. Close every attached connection (WS code 1001 = going away).
    try {
      this.registry.closeAll('daemon shutting down');
    } catch {
      // continue teardown
    }
    // 2. Stop accepting new handshakes.
    try {
      this.wss.close();
    } catch {
      // continue
    }
    // 3. Detach upgrade listener so the raw http.Server's `close()` (run
    //    earlier by RunningDaemon.close → app.close → server.close) doesn't
    //    still funnel into us. Defensive — if the server is already shut down
    //    `off` is a no-op.
    if (!this.detached) {
      try {
        this.server.off('upgrade', this.upgradeListener);
      } catch {
        // ignore
      }
      this.detached = true;
    }
    super.dispose();
  }
}
