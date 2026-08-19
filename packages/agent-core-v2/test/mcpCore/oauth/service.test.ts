import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpOAuthService } from '#/mcpCore/oauth/service';
import type { McpOAuthStore } from '#/mcpCore/oauth/store';

class MemoryStore implements McpOAuthStore {
  private readonly data = new Map<string, unknown>();

  read<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }

  write(key: string, data: unknown): Promise<void> {
    this.data.set(key, data);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

function startOAuthServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/register') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const parsed = JSON.parse(body) as { redirect_uris?: unknown };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              client_id: 'test-client',
              redirect_uris: parsed.redirect_uris ?? [],
              token_endpoint_auth_method: 'none',
            }),
          );
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 }));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function get(uri: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(uri, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('McpOAuthService', () => {
  let oauthServer: { url: string; close: () => Promise<void> } | undefined;
  let service: McpOAuthService;

  beforeEach(async () => {
    oauthServer = await startOAuthServer();
    service = new McpOAuthService({ store: new MemoryStore() });
  });

  afterEach(async () => {
    await oauthServer?.close();
    oauthServer = undefined;
  });

  it('cancel() interrupts a pending complete()', async () => {
    const flow = await service.beginAuthorization('test-server', oauthServer!.url);
    const complete = flow.complete({ timeoutMs: 10_000 });
    await flow.cancel();
    await expect(complete).rejects.toThrow();
  });

  it('completes the flow when the callback carries the expected state', async () => {
    const flow = await service.beginAuthorization('test-server', oauthServer!.url);
    const state = flow.authorizationUrl.searchParams.get('state');
    const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri');
    expect(state).toBeDefined();
    expect(redirectUri).toBeDefined();
    const complete = flow.complete({ timeoutMs: 10_000 });
    const status = await get(`${redirectUri}?code=abc123&state=${state}`);
    expect(status).toBe(200);
    await expect(complete).resolves.toBeUndefined();
    expect(await service.hasTokens('test-server', oauthServer!.url)).toBe(true);
  });

  it('rejects the flow when the callback state does not match', async () => {
    const flow = await service.beginAuthorization('test-server', oauthServer!.url);
    const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri');
    expect(redirectUri).toBeDefined();
    const complete = flow.complete({ timeoutMs: 10_000 });
    const assertion = expect(complete).rejects.toThrow(/state mismatch/);
    const status = await get(`${redirectUri}?code=abc123&state=wrong-state`);
    expect(status).toBe(200);
    await assertion;
    expect(await service.hasTokens('test-server', oauthServer!.url)).toBe(false);
  });
});
