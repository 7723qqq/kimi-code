/**
 * `/api/v2/ws` — creates the v2 (RPC) WebSocket server. The HTTP `upgrade`
 * event is dispatched by the bootstrap (`start.ts`), which routes by path so
 * this endpoint coexists with `/api/v1/ws`.
 *
 * Lifecycle / cleanup:
 *   - each connection is a {@link WsConnection}, tracked in the shared
 *     {@link IConnectionRegistry};
 *   - shutdown (close-all + wss.close) is owned by the bootstrap;
 *   - per-connection heartbeat / cleanup lives in {@link WsConnection}.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { WebSocketServer } from 'ws';

import { type IConnectionRegistry } from './connectionRegistry';
import { WsConnection } from './wsConnection';

export interface RegisterWsOptions {
  readonly token?: string;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** Registry that tracks live connections; populated by this module. */
  readonly registry: IConnectionRegistry;
}

export const WS_PATH = '/api/v2/ws';

export function registerWs(core: Scope, opts: RegisterWsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const { registry } = opts;

  wss.on('connection', (socket, req) => {
    const conn = new WsConnection({
      socket,
      core,
      token: opts.token,
      pingIntervalMs: opts.pingIntervalMs,
      pongTimeoutMs: opts.pongTimeoutMs,
      callTimeoutMs: opts.callTimeoutMs,
      remoteAddress: req.socket.remoteAddress ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    registry.add(conn);
    socket.on('close', () => registry.remove(conn.id));
  });

  return wss;
}
