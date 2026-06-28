/**
 * `/api/v2/ws` — mounts the WebSocket endpoint on Fastify's underlying HTTP
 * server. Uses `ws` in `noServer` mode and handles the `upgrade` event for the
 * `/api/v2/ws` path only; other upgrade requests are destroyed.
 *
 * Lifecycle / cleanup:
 *   - each connection is a {@link WsConnection}, tracked in a set;
 *   - on `app.close()` every connection is closed and the WS server is shut down;
 *   - per-connection heartbeat / cleanup lives in {@link WsConnection}.
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

import { WsConnection } from './wsConnection';

export interface RegisterWsOptions {
  readonly token?: string;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

const WS_PATH = '/api/v2/ws';

export function registerWs(app: FastifyInstance, core: Scope, opts: RegisterWsOptions = {}): void {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new Set<WsConnection>();

  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (url === WS_PATH || url.startsWith(`${WS_PATH}?`)) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (socket) => {
    const conn = new WsConnection({
      socket,
      core,
      token: opts.token,
      pingIntervalMs: opts.pingIntervalMs,
      pongTimeoutMs: opts.pongTimeoutMs,
      callTimeoutMs: opts.callTimeoutMs,
    });
    connections.add(conn);
    socket.on('close', () => connections.delete(conn));
  });

  app.addHook('onClose', async () => {
    for (const conn of connections) conn.close();
    wss.close();
  });
}
