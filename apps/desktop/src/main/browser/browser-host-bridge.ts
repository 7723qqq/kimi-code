import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { BrowserRunRequest } from '../../shared/browser-automation';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import type { DesktopEventName } from '../diagnostics/telemetry-events';
import { trySendDesktopEvent } from '../diagnostics/track';
import { browserAgentControl, browserSubagentControl } from './browser-agent-control';
import { agentLocalFilesEnabled } from './browser-view';
import { collectBrowserDialogReminder, forgetSessionBrowserDialogs, runBrowserAutomation } from './browser-automation';
import { restoreBrowserSubagentRuns, revokeBrowserSubagentRun } from './browser-control';
import type { DesktopBrowserSubagentRun } from './browser-subagent-control';

const BODY_LIMIT = 4 * 1024 * 1024;

export interface BrowserHostBridgeHandle {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

interface RunBody {
  input?: BrowserRunRequest;
  sessionId?: string;
  run?: BrowserSubagentRun;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function isRun(value: unknown): value is BrowserRunRequest {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)['operation'] === 'string';
}

function isSubagentRun(value: unknown): value is BrowserSubagentRun {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields['agentId'] === 'string'
    && typeof fields['generation'] === 'number'
    && typeof fields['turnId'] === 'number';
}

export async function startBrowserHostBridge(): Promise<BrowserHostBridgeHandle> {
  const token = randomBytes(32).toString('base64url');

  const authorized = (request: IncomingMessage): boolean =>
    request.headers.authorization === `Bearer ${token}`;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/state') {
      sendJson(response, 200, {
        agentControl: browserAgentControl.enabled(),
        subagentControl: browserSubagentControl.enabled(),
        localFiles: agentLocalFilesEnabled(),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/dialogs') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const reminder = sessionId === '' ? undefined : await collectBrowserDialogReminder(sessionId);
      sendJson(response, 200, { reminder });
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    const body = await readBody(request);
    if (url.pathname === '/run') {
      const fields = (body ?? {}) as RunBody;
      if (!isRun(fields.input)) {
        sendJson(response, 400, { error: 'invalid browser run input' });
        return;
      }
      const controller = new AbortController();
      request.once('aborted', () => controller.abort());
      response.once('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      const subagent = isSubagentRun(fields.run)
        ? ({ run: fields.run, assertActive: () => {} } satisfies DesktopBrowserSubagentRun)
        : undefined;
      const result = await runBrowserAutomation(fields.input, controller.signal, fields.sessionId, subagent);
      sendJson(response, 200, { result });
      return;
    }
    if (url.pathname === '/dialogs/forget') {
      const fields = (body ?? {}) as { sessionId?: unknown };
      if (typeof fields.sessionId === 'string') forgetSessionBrowserDialogs(fields.sessionId);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/restore-subagent-runs') {
      restoreBrowserSubagentRuns();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/revoke-subagent-run') {
      const fields = (body ?? {}) as { sessionId?: unknown; run?: unknown };
      if (typeof fields.sessionId === 'string' && isSubagentRun(fields.run)) {
        revokeBrowserSubagentRun(fields.sessionId, fields.run);
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/track') {
      const fields = (body ?? {}) as { event?: unknown; properties?: unknown };
      if (typeof fields.event === 'string') {
        trySendDesktopEvent(fields.event as DesktopEventName, fields.properties as never);
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}
