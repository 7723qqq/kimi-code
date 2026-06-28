import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ISessionIndex, ISessionMetadata } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { RpcClient, RpcError } from '../src/transport/rpcClient';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface SessionMetaWire {
  id: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

describe('server-v2 /api/v2 RPC', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rpc-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    arg?: unknown,
    token?: string,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const headers: Record<string, string> = {};
    let url = `${base}${path}`;
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (method === 'GET') {
      if (arg !== undefined) url += `?arg=${encodeURIComponent(JSON.stringify(arg))}`;
    } else if (arg !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(arg);
    }
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    const res = await fetch(url, init);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd } }),
    });
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // --- Core scope -----------------------------------------------------------

  it('lists sessions via GET (readonly)', async () => {
    const { body } = await call<{ items: unknown[]; has_more: boolean }>(
      'GET',
      '/api/v2/sessions:list',
      {},
    );
    expect(body.code).toBe(0);
    expect(Array.isArray(body.data.items)).toBe(true);
  });

  it('creates a workspace and reads it back', async () => {
    const cwd = home as string;
    const created = await call<{ id: string; root: string }>(
      'POST',
      '/api/v2/workspaces:createOrTouch',
      cwd,
    );
    expect(created.body.code).toBe(0);
    expect(created.body.data.root).toBe(cwd);

    const got = await call<{ id: string; root: string }>(
      'GET',
      '/api/v2/workspaces:get',
      created.body.data.id,
    );
    expect(got.body.code).toBe(0);
    expect(got.body.data.root).toBe(cwd);
  });

  it('counts active sessions', async () => {
    const cwd = home as string;
    const created = await call<{ id: string }>('POST', '/api/v2/workspaces:createOrTouch', cwd);
    await createSession(cwd);
    const { body } = await call<number>(
      'POST',
      '/api/v2/sessions:countActive',
      created.body.data.id,
    );
    expect(body.code).toBe(0);
    expect(body.data).toBeGreaterThanOrEqual(1);
  });

  // --- Session scope --------------------------------------------------------

  it('reads and updates session metadata', async () => {
    const id = await createSession(home as string);

    const read = await call<SessionMetaWire>('POST', `/api/v2/session/${id}/session:read`);
    expect(read.body.code).toBe(0);
    expect(read.body.data.id).toBe(id);

    const set = await call<null>('POST', `/api/v2/session/${id}/session:setTitle`, 'renamed');
    expect(set.body.code).toBe(0);

    const read2 = await call<SessionMetaWire>('POST', `/api/v2/session/${id}/session:read`);
    expect(read2.body.data.title).toBe('renamed');
  });

  it('returns session status', async () => {
    const id = await createSession(home as string);
    const { body } = await call<string>('POST', `/api/v2/session/${id}/session:status`);
    expect(body.code).toBe(0);
    expect(['idle', 'running', 'awaiting_approval', 'awaiting_question']).toContain(body.data);
  });

  it('archives a session', async () => {
    const id = await createSession(home as string);
    const { body } = await call<null>('POST', `/api/v2/session/${id}/session:archive`);
    expect(body.code).toBe(0);
  });

  // --- typed client ---------------------------------------------------------

  it('works through the typed RpcClient', async () => {
    const cwd = home as string;
    await createSession(cwd);
    const client = new RpcClient({ url: base });

    const sessions = client.core<ISessionIndex>('sessions');
    const page = await sessions.list({});
    expect(page.items.length).toBeGreaterThanOrEqual(1);

    const id = page.items[0]!.id;
    const meta = client.session(id).service<ISessionMetadata>('session');
    const read = await meta.read();
    expect(read.id).toBe(id);
  });

  it('throws RpcError on unknown action', async () => {
    const client = new RpcClient({ url: base });
    const sessions = client.core<ISessionIndex>('sessions');
    // @ts-expect-error — intentionally calling a non-existent method
    await expect(sessions.nope()).rejects.toBeInstanceOf(RpcError);
  });

  // --- NFR ------------------------------------------------------------------

  it('rejects unknown action (40001)', async () => {
    const { body } = await call<null>('POST', '/api/v2/sessions:nope');
    expect(body.code).toBe(40001);
  });

  it('rejects malformed segment without colon (40001)', async () => {
    const { body } = await call<null>('POST', '/api/v2/sessions');
    expect(body.code).toBe(40001);
  });

  it('rejects unknown session (40401)', async () => {
    const { body } = await call<null>('POST', '/api/v2/session/nope/session:read');
    expect(body.code).toBe(40401);
  });

  it('rejects GET on a write action (40001)', async () => {
    const id = await createSession(home as string);
    const { body } = await call<null>('GET', `/api/v2/session/${id}/session:archive`);
    expect(body.code).toBe(40001);
  });

  it('rejects oversized body', async () => {
    // Fastify's default bodyLimit is 1MB; a larger body is rejected. Fastify's
    // body-parser throws a 413 which our global error handler currently wraps
    // as `50001` (HTTP 200) — either way the request is rejected, not served.
    const huge = 'x'.repeat(2 * 1024 * 1024);
    let rejected = false;
    let code: number | undefined;
    try {
      const res = await fetch(`${base}/api/v2/sessions:list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ big: huge }),
      });
      const body = (await res.json()) as Envelope<null>;
      rejected = res.status === 413 || body.code !== 0;
      code = body.code;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(code).not.toBe(0);
  });

  it('does not leak stack traces on error', async () => {
    const { body } = await call<null>('POST', '/api/v2/session/nope/session:read');
    expect(JSON.stringify(body)).not.toContain('stack');
  });
});

describe('server-v2 /api/v2 RPC auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const token = 'test-secret-token';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rpc-auth-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      rpcToken: token,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('rejects calls without a token (40112)', async () => {
    const res = await fetch(`${base}/api/v2/sessions:list`, { method: 'POST' });
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40112);
  });

  it('accepts calls with the correct token', async () => {
    const res = await fetch(`${base}/api/v2/sessions:list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Envelope<{ items: unknown[] }>;
    expect(body.code).toBe(0);
  });

  it('rejects a wrong token (40112)', async () => {
    const res = await fetch(`${base}/api/v2/sessions:list`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40112);
  });
});
