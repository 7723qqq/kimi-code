import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { startCallbackServer, type CallbackServer } from '#/mcpCore/oauth/callback-server';

function get(uri: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(uri, { headers: host !== undefined ? { host } : undefined }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('callback-server', () => {
  let server: CallbackServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('resolves the authorization code and state on a well-formed callback', async () => {
    server = await startCallbackServer();
    const wait = server.waitForCode({ timeoutMs: 2000 });
    const status = await get(`${server.redirectUri}?code=abc123&state=xyz`);
    expect(status).toBe(200);
    await expect(wait).resolves.toEqual({ code: 'abc123', state: 'xyz' });
  });

  it('rejects callbacks with a mismatched Host header', async () => {
    server = await startCallbackServer();
    let settled = false;
    const wait = server.waitForCode({ timeoutMs: 2000 });
    void wait.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    const status = await get(`${server.redirectUri}?code=abc123`, 'evil.example');
    expect(status).toBe(404);
    await sleep(100);
    expect(settled).toBe(false);
  });

  it('rejects when the server reports an OAuth error', async () => {
    server = await startCallbackServer();
    const wait = server.waitForCode({ timeoutMs: 2000 });
    const assertion = expect(wait).rejects.toThrow(/access_denied/);
    const status = await get(`${server.redirectUri}?error=access_denied&error_description=no`);
    expect(status).toBe(400);
    await assertion;
  });

  it('rejects when the callback is missing the authorization code', async () => {
    server = await startCallbackServer();
    const wait = server.waitForCode({ timeoutMs: 2000 });
    const assertion = expect(wait).rejects.toThrow(/missing authorization code/);
    const status = await get(`${server.redirectUri}?state=xyz`);
    expect(status).toBe(400);
    await assertion;
  });

  it('rejects non-GET requests', async () => {
    server = await startCallbackServer();
    let settled = false;
    const wait = server.waitForCode({ timeoutMs: 2000 });
    void wait.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(server!.redirectUri, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
    await sleep(100);
    expect(settled).toBe(false);
  });

  it('rejects paths other than /callback', async () => {
    server = await startCallbackServer();
    let settled = false;
    const wait = server.waitForCode({ timeoutMs: 2000 });
    void wait.then(
      () => {
        settled = true;
        return undefined;
      },
      () => {
        settled = true;
        return undefined;
      },
    );
    const status = await get(`${server.redirectUri.replace('/callback', '/other')}?code=abc`);
    expect(status).toBe(404);
    await sleep(100);
    expect(settled).toBe(false);
  });

  it('times out when no callback arrives', async () => {
    server = await startCallbackServer();
    await expect(server.waitForCode({ timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
