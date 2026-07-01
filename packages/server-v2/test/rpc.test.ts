import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import type { ISessionIndex, ISessionMetadata } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { RpcClient, RpcError } from '../src/transport/rpcClient';
import { authHeaders } from './helpers/auth';

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

interface GoalSnapshotWire {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budget: unknown;
  terminalReason?: string;
}

interface GoalToolResultWire {
  goal: GoalSnapshotWire | null;
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
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
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
    // Default to the persistent bearer token — `/api/v2` is now gated by the
    // same credential as every other route.
    const credential = token ?? (server as RunningServer).authTokenService.getToken();
    headers['authorization'] = `Bearer ${credential}`;
    const res = await fetch(url, init);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here so the agent-scope dispatch resolves.
  async function createMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    await session.accessor.get(IAgentLifecycleService).createMain();
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

  it('renames a workspace via update', async () => {
    const cwd = home as string;
    const created = await call<{ id: string; name: string }>(
      'POST',
      '/api/v2/workspaces:createOrTouch',
      cwd,
    );
    const id = created.body.data.id;

    const updated = await call<{ id: string; name: string }>(
      'POST',
      '/api/v2/workspaces:update',
      [id, { name: 'renamed' }],
    );
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.name).toBe('renamed');

    const got = await call<{ id: string; name: string }>(
      'GET',
      '/api/v2/workspaces:get',
      id,
    );
    expect(got.body.data.name).toBe('renamed');
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

  // --- Agent scope ----------------------------------------------------------

  it('submits a prompt and returns the turn id', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<{ turn_id: number }>(
      'POST',
      `/api/v2/session/${id}/agent/main/prompts:submit`,
      { input: [{ type: 'text', text: 'hello' }] },
    );
    expect(body.code).toBe(0);
    expect(body.data.turn_id).toBe(0);
  });

  it('runs a shell command through shell:run', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const { body } = await call<{ stdout: string; stderr: string; isError?: boolean }>(
      'POST',
      `/api/v2/session/${id}/agent/main/shell:run`,
      { command: 'printf hello' },
    );
    expect(body.code).toBe(0);
    expect(body.data.stdout).toBe('hello');
    expect(body.data.stderr).toBe('');
    expect(body.data.isError).not.toBe(true);
  });

  it('controls goals through goal:* RPC', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    const created = await call<GoalSnapshotWire>(
      'POST',
      `/api/v2/session/${id}/agent/main/goal:create`,
      { objective: 'finish the migration' },
    );
    expect(created.body.code).toBe(0);
    expect(created.body.data).toMatchObject({
      objective: 'finish the migration',
      status: 'active',
    });

    const read = await call<GoalToolResultWire>(
      'GET',
      `/api/v2/session/${id}/agent/main/goal:get`,
    );
    expect(read.body.code).toBe(0);
    expect(read.body.data.goal).toMatchObject({
      objective: 'finish the migration',
      status: 'active',
    });

    const paused = await call<GoalSnapshotWire>(
      'POST',
      `/api/v2/session/${id}/agent/main/goal:pause`,
      {},
    );
    expect(paused.body.data.status).toBe('paused');

    const resumed = await call<GoalSnapshotWire>(
      'POST',
      `/api/v2/session/${id}/agent/main/goal:resume`,
      {},
    );
    expect(resumed.body.data.status).toBe('active');

    const cancelled = await call<GoalSnapshotWire>(
      'POST',
      `/api/v2/session/${id}/agent/main/goal:cancel`,
      {},
    );
    expect(cancelled.body.code).toBe(0);
    expect(cancelled.body.data.status).toBe('active');

    const afterCancel = await call<GoalToolResultWire>(
      'GET',
      `/api/v2/session/${id}/agent/main/goal:get`,
    );
    expect(afterCancel.body.data.goal).toBeNull();
  });

  it('maps goal errors through RPC envelopes', async () => {
    const id = await createSession(home as string);
    await createMainAgent(id);

    await call<GoalSnapshotWire>(
      'POST',
      `/api/v2/session/${id}/agent/main/goal:create`,
      { objective: 'first' },
    );
    const duplicate = await call<null>(
      'POST',
      `/api/v2/session/${id}/agent/main/goal:create`,
      { objective: 'second' },
    );
    expect(duplicate.body.code).toBe(40913);
  });

  it('lists and installs plugins through plugins:* RPC', async () => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'server-v2-plugin-source-'));
    try {
      await writeFile(join(pluginRoot, 'deploy.md'), '---\ndescription: Deploy\n---\n\nDeploy body', 'utf8');
      await writeFile(
        join(pluginRoot, 'kimi.plugin.json'),
        JSON.stringify({ name: 'rpc-plugin', commands: ['./deploy.md'] }),
        'utf8',
      );

      const installed = await call<{ id: string }>('POST', '/api/v2/plugins:install', { source: pluginRoot });
      expect(installed.body.code).toBe(0);
      expect(installed.body.data.id).toBe('rpc-plugin');

      const listed = await call<readonly { id: string; state: string }[]>('GET', '/api/v2/plugins:list');
      expect(listed.body.code).toBe(0);
      expect(listed.body.data).toEqual([
        expect.objectContaining({ id: 'rpc-plugin', state: 'ok' }),
      ]);

      const info = await call<{ id: string }>('POST', '/api/v2/plugins:getInfo', { id: 'rpc-plugin' });
      expect(info.body.code).toBe(0);
      expect(info.body.data.id).toBe('rpc-plugin');

      const commands = await call<readonly { pluginId: string; name: string }[]>(
        'GET',
        '/api/v2/plugins:listCommands',
      );
      expect(commands.body.code).toBe(0);
      expect(commands.body.data).toEqual([
        expect.objectContaining({ pluginId: 'rpc-plugin', name: 'deploy' }),
      ]);

      const sessionId = await createSession(home as string);
      await createMainAgent(sessionId);
      const activated = await call<null>(
        'POST',
        `/api/v2/session/${sessionId}/agent/main/plugins:activateCommand`,
        { pluginId: 'rpc-plugin', commandName: 'deploy', args: 'prod' },
      );
      expect(activated.body.code).toBe(0);
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  });

  it('returns 40401 when the agent does not exist', async () => {
    const id = await createSession(home as string);
    const { body } = await call<null>(
      'POST',
      `/api/v2/session/${id}/agent/does-not-exist/prompts:submit`,
      { input: [{ type: 'text', text: 'hello' }] },
    );
    expect(body.code).toBe(40401);
  });

  // --- typed client ---------------------------------------------------------

  it('works through the typed RpcClient', async () => {
    const cwd = home as string;
    await createSession(cwd);
    const client = new RpcClient({
      url: base,
      token: (server as RunningServer).authTokenService.getToken(),
    });

    const sessions = client.core<ISessionIndex>('sessions');
    const page = await sessions.list({});
    expect(page.items.length).toBeGreaterThanOrEqual(1);

    const id = page.items[0]!.id;
    const meta = client.session(id).service<ISessionMetadata>('session');
    const read = await meta.read();
    expect(read.id).toBe(id);
  });

  it('throws RpcError on unknown action', async () => {
    const client = new RpcClient({
      url: base,
      token: (server as RunningServer).authTokenService.getToken(),
    });
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
    // A valid token is sent so the request reaches the body parser (the auth
    // hook would short-circuit with 401 before reading the body otherwise).
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const token = (server as RunningServer).authTokenService.getToken();
    let rejected = false;
    let code: number | undefined;
    try {
      const res = await fetch(`${base}/api/v2/sessions:list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
  });

  it('rejects calls without a token (40101)', async () => {
    const res = await fetch(`${base}/api/v2/sessions:list`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40101);
  });

  it('accepts calls with the correct rpcToken', async () => {
    const res = await fetch(`${base}/api/v2/sessions:list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Envelope<{ items: unknown[] }>;
    expect(body.code).toBe(0);
  });

  it('accepts the persistent token on /api/v2', async () => {
    const persistent = (server as RunningServer).authTokenService.getToken();
    const res = await fetch(`${base}/api/v2/sessions:list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${persistent}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Envelope<{ items: unknown[] }>;
    expect(body.code).toBe(0);
  });

  it('rejects a wrong token (40101)', async () => {
    const res = await fetch(`${base}/api/v2/sessions:list`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40101);
  });
});
