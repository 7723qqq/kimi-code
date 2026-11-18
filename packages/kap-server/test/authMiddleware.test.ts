import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { removeTempHome } from './helpers/tempHome';

describe('server-v2 /api/v1 bearer auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-middleware-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
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

  it('allows healthz without a token', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/api/v1/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects /api/v1/auth without a token with 40101', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/api/v1/auth' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('rejects /api/v1/auth with a wrong token', async () => {
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(40101);
  });

  it('accepts /api/v1/auth with the persistent token', async () => {
    const token = server!.authTokenService.getToken();
    const res = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(0);
  });

  it('bridges an authenticated browser to same-origin GET downloads without authorizing other APIs', async () => {
    const auth = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: {
        authorization: `Bearer ${server!.authTokenService.getToken()}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    const setCookie = auth.headers['set-cookie'];
    const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(value).toBeString();
    expect(value).toContain('HttpOnly');
    expect(value).toContain('SameSite=Strict');
    expect(value).not.toContain(server!.authTokenService.getToken());
    const cookie = value!.split(';', 1)[0]!;
    const download = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/files/f_missing',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(download.statusCode).not.toBe(401);
    for (const [method, url] of [
      ['GET', '/api/v1/auth'],
      ['GET', '/openapi.json'],
      ['POST', '/api/v1/sessions'],
      ['GET', '/api/v1/fs:content?path=D:/private.txt'],
    ]) {
      const response = await server!.app.inject({
        method,
        url,
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      } as never);
      expect(response.statusCode).toBe(401);
    }
    const crossSite = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/files/f_missing',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(401);
    const hostileBearer = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/files/f_missing',
      headers: { cookie, authorization: 'Bearer wrong-token', 'sec-fetch-site': 'same-origin' },
    });
    expect(hostileBearer.statusCode).toBe(401);
    const forged = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/files/f_missing',
      headers: { cookie: cookie + 'forged', 'sec-fetch-site': 'same-origin' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('isolates download grants by host and port, expires them, and revalidates revoked credentials', async () => {
    const auth = await server!.app.inject({
      method: 'GET',
      url: '/api/v1/auth',
      headers: {
        host: 'localhost:1234',
        authorization: `Bearer ${server!.authTokenService.getToken()}`,
        'sec-fetch-site': 'same-origin',
      },
    });
    const setCookie = auth.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;
    const download = (host: string) =>
      server!.app.inject({
        method: 'GET',
        url: '/api/v1/files/f_missing',
        headers: { host, cookie, 'sec-fetch-site': 'same-origin' },
      });
    expect((await download('localhost:1234')).statusCode).not.toBe(401);
    expect((await download('localhost:1235')).statusCode).toBe(401);
    expect((await download('other.test:1234')).statusCode).toBe(403);
    const validate = spyOn(server!.authTokenService, 'isValid').mockResolvedValue(false);
    try {
      expect((await download('localhost:1234')).statusCode).toBe(401);
    } finally {
      validate.mockRestore();
    }
    const now = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(now + 300001);
    try {
      expect((await download('localhost:1234')).statusCode).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  it('requires auth for /openapi.json', async () => {
    const res = await server!.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(401);
  });
});
