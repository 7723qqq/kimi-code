import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import { connectionsListResponseSchema } from '../src/protocol/rest-connection';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { removeTempHome } from './helpers/tempHome';
import { waitForAssertion } from './helpers/waitFor';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 GET /api/v1/connections', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-connections-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await removeTempHome(home);
      home = undefined;
    }
  });

  async function listConnections() {
    const res = await fetch(`${base}/api/v1/connections`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    return connectionsListResponseSchema.parse(body.data).connections;
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

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const token = (server as RunningServer).authTokenService.getToken();
      const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${token}`]);
      ws.once('message', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function send(ws: WebSocket, frame: Record<string, unknown>): void {
    ws.send(JSON.stringify(frame));
  }

  async function waitForFrame(
    frames: readonly Record<string, unknown>[],
    type: string,
    timeoutMs = 2000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = frames.find((frame) => frame['type'] === type);
      if (hit !== undefined) return hit;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`frame ${type} not observed within ${timeoutMs}ms`);
  }

  async function waitForSize(target: number, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (server?.connectionRegistry.size() === target) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`registry size ${target} not observed within ${timeoutMs}ms`);
  }

  it('returns an empty list when no clients are attached', async () => {
    const connections = await listConnections();
    expect(connections).toEqual([]);
  });

  it('lists a raw connection without hello', async () => {
    const ws = await connect();
    const closed = new Promise<void>((res) => ws.on('close', () => res()));
    await waitForSize(1);

    const connections = await listConnections();
    expect(connections).toHaveLength(1);
    const c = connections[0]!;
    expect(c.id).toMatch(/^conn_/);
    expect(c.has_client_hello).toBe(false);
    expect(c.subscriptions).toEqual([]);
    expect(c.connected_at).toMatch(/Z$/);
    expect(typeof c.remote_address).toBe('string');
    expect((c.remote_address ?? '').length).toBeGreaterThan(0);

    ws.close();
    await closed;
  });

  it('reflects client_hello and session subscriptions', async () => {
    const sessionId = await createSession(home as string);
    const ws = await connect();
    try {
      send(ws, {
        type: 'client_hello',
        id: 'h1',
        payload: { client_id: 'connections-test' },
      });
      send(ws, {
        type: 'subscribe_v2',
        id: 's1',
        payload: { session_id: sessionId, transcript: { main: 'delta' } },
      });

      let connections = await listConnections();
      await waitForAssertion(async () => {
        connections = await listConnections();
        expect(connections[0]?.subscriptions).toContain(sessionId);
      });
      expect(connections).toHaveLength(1);
      const c = connections[0]!;
      expect(c.has_client_hello).toBe(true);
      expect(c.subscriptions).toContain(sessionId);

      send(ws, {
        type: 'unsubscribe_v2',
        id: 'u1',
        payload: { session_id: sessionId },
      });
      await new Promise((r) => setTimeout(r, 50));
      connections = await listConnections();
      expect(connections[0]!.has_client_hello).toBe(true);
    } finally {
      ws.close();
    }
  });

  it('pushes task.list for an agent the connection starts receiving', async () => {
    const sessionId = await createSession(home as string);
    const ws = await connect();
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (data: Buffer) => {
      frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });
    try {
      send(ws, {
        type: 'subscribe_v2',
        id: 'v2-1',
        payload: { session_id: sessionId, transcript: { main: 'delta' } },
      });
      const list = await waitForFrame(frames, 'task.list');
      expect(list['session_id']).toBe(sessionId);
      expect(list['agent_id']).toBe('main');
      expect(list['tasks']).toEqual([]);

      const agent = await waitForFrame(frames, 'agent');
      expect(agent).toMatchObject({ session_id: sessionId, agent_id: 'main', status: 'idle' });

      const todo = await waitForFrame(frames, 'todo');
      expect(todo).toMatchObject({ session_id: sessionId, agent_id: 'main', items: [] });
    } finally {
      ws.close();
    }
  });

  it('removes the connection after the socket closes', async () => {
    const ws = await connect();
    send(ws, {
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'connections-test', subscriptions: [] },
    });
    await waitForSize(1);

    ws.close();
    await waitForSize(0);

    const connections = await listConnections();
    expect(connections).toEqual([]);
  });
});
