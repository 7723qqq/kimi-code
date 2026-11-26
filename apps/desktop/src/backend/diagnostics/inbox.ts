import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { TelemetryProperties } from '@moonshot-ai/agent-core-v2';

import { trySendDesktopEvent } from './track';

export interface TelemetryInbox {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function startTelemetryInbox(): Promise<TelemetryInbox> {
  const token = randomBytes(32).toString('base64url');
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method !== 'POST' || (request.url ?? '') !== '/track') {
      send(response, 404, { error: 'not found' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 256 * 1024) throw new Error('request body too large');
      chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      event?: unknown;
      properties?: unknown;
    };
    if (typeof parsed.event === 'string') {
      trySendDesktopEvent(parsed.event, parsed.properties as TelemetryProperties | undefined);
    }
    send(response, 200, { ok: true });
  };
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}
