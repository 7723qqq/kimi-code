import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

describe('server-v2 boot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

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

  it('boots agent-core-v2 and serves the basic /api/v1 routes', async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });

    const base = `http://127.0.0.1:${server.port}`;

    const healthz = await fetch(`${base}/api/v1/healthz`);
    expect(healthz.status).toBe(200);
    const healthBody = await healthz.json() as {
      code: number;
      data: { ok: boolean };
      request_id: string;
    };
    expect(healthBody.code).toBe(0);
    expect(healthBody.data.ok).toBe(true);
    expect(typeof healthBody.request_id).toBe('string');

    const meta = await fetch(`${base}/api/v1/meta`);
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as {
      code: number;
      data: { server_id: string; server_version: string; capabilities: Record<string, boolean> };
    };
    expect(metaBody.code).toBe(0);
    expect(typeof metaBody.data.server_id).toBe('string');
    expect(typeof metaBody.data.server_version).toBe('string');
    expect(metaBody.data.capabilities).toBeDefined();

    const auth = await fetch(`${base}/api/v1/auth`);
    expect(auth.status).toBe(200);
    const authBody = await auth.json() as {
      code: number;
      data: { ready: boolean; providers_count: number; default_model: string | null };
    };
    expect(authBody.code).toBe(0);
    expect(typeof authBody.data.ready).toBe('boolean');
    expect(authBody.data.providers_count).toBeGreaterThanOrEqual(0);

    // Poll with no flow in flight → null payload; exercises the v2 IOAuthService
    // wiring without starting a real (networked) device-code flow.
    const oauthPoll = await fetch(`${base}/api/v1/oauth/login`);
    expect(oauthPoll.status).toBe(200);
    const oauthBody = await oauthPoll.json() as { code: number; data: null };
    expect(oauthBody.code).toBe(0);
    expect(oauthBody.data).toBeNull();
  });
});
