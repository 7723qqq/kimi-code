import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocket } from 'ws';

import { registerShutdownRoutes } from '../src/routes/shutdown';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch, bearerToken } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('shutdown route', () => {
  interface Captured {
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void;
  }

  function harness(drain: boolean) {
    const captured: Captured[] = [];
    let shutdowns = 0;
    registerShutdownRoutes(
      {
        post: (_path: string, _options: unknown, handler: Captured['handler']): unknown => {
          captured.push({ handler });
          return undefined;
        },
      } as never,
      { onShutdown: () => (shutdowns += 1), drainIdleSessions: async () => drain },
    );
    const route = captured.at(0);
    if (route === undefined) throw new Error('POST /shutdown route was not registered');
    let payload: Envelope<{ ok: boolean }> | undefined;
    const send = async (query: unknown): Promise<void> => {
      await route.handler(
        { id: 'req-1', query },
        {
          send: (value: unknown) => {
            payload = value as Envelope<{ ok: boolean }>;
          },
        },
      );
    };
    return {
      send,
      payload: () => payload,
      shutdowns: () => shutdowns,
    };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('shuts down unconditionally without if_idle', async () => {
    const route = harness(false);
    await route.send({});
    expect(route.payload()?.data).toEqual({ ok: true });
    await tick();
    expect(route.shutdowns()).toBe(1);
  });

  it('answers ok: false and keeps running when if_idle finds live work', async () => {
    const route = harness(false);
    await route.send({ if_idle: 'true' });
    expect(route.payload()?.data).toEqual({ ok: false });
    await tick();
    expect(route.shutdowns()).toBe(0);
  });

  it('shuts down when if_idle finds no live work', async () => {
    const route = harness(true);
    await route.send({ if_idle: 'true' });
    expect(route.payload()?.data).toEqual({ ok: true });
    await tick();
    expect(route.shutdowns()).toBe(1);
  });
});

describe('POST /api/v1/shutdown?if_idle=true', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let socket: WebSocket | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-shutdown-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
    socket?.close();
    socket = undefined;
    try {
      await server?.close();
    } finally {
      server = undefined;
      if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('refuses while a client is connected and keeps the server serving', async () => {
    const live = server as RunningServer;
    socket = new WebSocket(`ws://127.0.0.1:${live.port}/api/v1/ws`, [
      `kimi-code.bearer.${bearerToken(live)}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket?.once('open', resolve);
      socket?.once('error', reject);
    });

    const response = await authedFetch(
      live,
      `http://127.0.0.1:${live.port}`,
      '/api/v1/shutdown?if_idle=true',
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<{ ok: boolean }>;
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ ok: false });

    const health = await authedFetch(live, `http://127.0.0.1:${live.port}`, '/api/v1/healthz');
    expect(health.status).toBe(200);
  });
});
