import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpOAuthService } from '#/mcpCore/oauth/service';
import type { McpOAuthCredentialsCoordinator } from '#/mcpCore/oauth/coordinator';
import { McpOAuthClientProvider } from '#/mcpCore/oauth/provider';
import { mcpOAuthStoreKey, META_SUFFIX, type McpOAuthStore } from '#/mcpCore/oauth/store';

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

  list(suffix: string): Promise<readonly string[]> {
    return Promise.resolve([...this.data.keys()].filter((key) => key.endsWith(suffix)));
  }
}

function startOAuthServer(
  tokenHandler: (body: URLSearchParams) => { status: number; payload: unknown },
): Promise<{ url: string; close: () => Promise<void> }> {
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
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          const { status, payload } = tokenHandler(new URLSearchParams(body));
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        });
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

function seedGrant(
  store: McpOAuthStore,
  serverName: string,
  serverUrl: string,
  tokens: { access_token: string; refresh_token?: string; expires_in?: number },
): void {
  const key = mcpOAuthStoreKey(serverName, serverUrl);
  void store.write(`${key}-tokens.json`, {
    ...tokens,
    obtained_at: Date.now(),
  });
  void store.write(`${key}${META_SUFFIX}`, { serverName, serverUrl });
}

function spyCoordinator(): McpOAuthCredentialsCoordinator & {
  updated: string[];
  invalidated: string[];
} {
  const updated: string[] = [];
  const invalidated: string[] = [];
  return {
    updated,
    invalidated,
    notifyCredentialsChanged(serverName) {
      updated.push(serverName);
    },
    notifyCredentialsInvalidated(serverName) {
      invalidated.push(serverName);
    },
    onCredentialsChanged: () => () => {},
  };
}

async function waitFor(probe: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('McpOAuthService lifecycle', () => {
  let oauthServer: { url: string; close: () => Promise<void> } | undefined;
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await oauthServer?.close();
    oauthServer = undefined;
  });

  it('refresh() is single-flight per credential', async () => {
    let tokenCalls = 0;
    oauthServer = await startOAuthServer(() => {
      tokenCalls += 1;
      return {
        status: 200,
        payload: { access_token: 'new', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 },
      };
    });
    seedGrant(store, 'srv', oauthServer.url, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_in: 3600,
    });
    const service = new McpOAuthService({ store });

    const [a, b] = await Promise.all([
      service.refresh('srv', oauthServer.url),
      service.refresh('srv', oauthServer.url),
    ]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(tokenCalls).toBe(1);
    await service.shutdown();
  });

  it('refresh() fails when the stored grant has no refresh token', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 'x', token_type: 'Bearer', expires_in: 3600 },
    }));
    seedGrant(store, 'srv', oauthServer.url, { access_token: 'old', expires_in: 3600 });
    const service = new McpOAuthService({ store });

    await expect(service.refresh('srv', oauthServer.url)).rejects.toThrow(/no refreshable OAuth grant/);
    await service.shutdown();
  });

  it('sweepProactiveRefresh() arms a timer that refreshes near expiry', async () => {
    let tokenCalls = 0;
    oauthServer = await startOAuthServer(() => {
      tokenCalls += 1;
      return {
        status: 200,
        payload: { access_token: 'new', refresh_token: 'rt-2', token_type: 'Bearer', expires_in: 3600 },
      };
    });
    // Expires in 30s: within the 120s ahead-of-expiry window, so the sweep
    // fires an immediate refresh.
    seedGrant(store, 'srv', oauthServer.url, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_in: 30,
    });
    const service = new McpOAuthService({ store });

    await service.sweepProactiveRefresh();
    await waitFor(() => tokenCalls === 1);
    expect(tokenCalls).toBe(1);
    await service.shutdown();
  });

  it('emits refresh-failed when the proactive refresh is rejected', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 400,
      payload: { error: 'invalid_grant' },
    }));
    seedGrant(store, 'srv', oauthServer.url, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_in: 30,
    });
    const service = new McpOAuthService({ store });
    const failures: string[] = [];
    service.onEvent((event) => {
      if (event.type === 'refresh-failed') failures.push(event.serverName);
    });

    await service.sweepProactiveRefresh();
    await waitFor(() => failures.length === 1);
    expect(failures).toEqual(['srv']);
    await service.shutdown();
  });

  it('emits tokens-saved and notifies the coordinator after a completed login', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
    }));
    const coordinator = spyCoordinator();
    const service = new McpOAuthService({ store, coordinator });
    const saved: string[] = [];
    service.onEvent((event) => {
      if (event.type === 'tokens-saved') saved.push(event.serverName);
    });

    const flow = await service.beginAuthorization('srv', oauthServer.url);
    const state = flow.authorizationUrl.searchParams.get('state');
    const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri');
    const complete = flow.complete({ timeoutMs: 10_000 });
    const status = await get(`${redirectUri}?code=abc123&state=${state}`);
    expect(status).toBe(200);
    await complete;

    expect(saved).toEqual(['srv']);
    expect(coordinator.updated).toEqual(['srv']);
    expect(await service.hasTokens('srv', oauthServer.url)).toBe(true);
    await service.shutdown();
  });

  it('emits tokens-invalidated and notifies the coordinator on invalidate()', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
    }));
    const coordinator = spyCoordinator();
    const service = new McpOAuthService({ store, coordinator });
    const invalidated: string[] = [];
    service.onEvent((event) => {
      if (event.type === 'tokens-invalidated') invalidated.push(event.serverName);
    });

    const flow = await service.beginAuthorization('srv', oauthServer.url);
    const state = flow.authorizationUrl.searchParams.get('state');
    const redirectUri = flow.authorizationUrl.searchParams.get('redirect_uri');
    const complete = flow.complete({ timeoutMs: 10_000 });
    await get(`${redirectUri}?code=abc123&state=${state}`);
    await complete;
    await service.invalidate('srv', oauthServer.url);

    expect(invalidated).toEqual(['srv']);
    expect(coordinator.invalidated).toEqual(['srv']);
    expect(await service.hasTokens('srv', oauthServer.url)).toBe(false);
    await service.shutdown();
  });

  it('joins concurrent beginAuthorization calls for the same credential', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
    }));
    const service = new McpOAuthService({ store });

    const [a, b] = await Promise.all([
      service.beginAuthorization('srv', oauthServer.url),
      service.beginAuthorization('srv', oauthServer.url),
    ]);
    expect(b.authorizationUrl.toString()).toBe(a.authorizationUrl.toString());

    const state = a.authorizationUrl.searchParams.get('state');
    const redirectUri = a.authorizationUrl.searchParams.get('redirect_uri');
    const completeA = a.complete({ timeoutMs: 10_000 });
    const completeB = b.complete({ timeoutMs: 10_000 });
    await get(`${redirectUri}?code=abc123&state=${state}`);
    await expect(completeA).resolves.toBeUndefined();
    await expect(completeB).resolves.toBeUndefined();
    await service.shutdown();
  });

  it('detaches a joined caller without cancelling the shared flow', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
    }));
    const service = new McpOAuthService({ store });

    const a = await service.beginAuthorization('srv', oauthServer.url);
    const b = await service.beginAuthorization('srv', oauthServer.url);
    await b.cancel();
    const state = a.authorizationUrl.searchParams.get('state');
    const redirectUri = a.authorizationUrl.searchParams.get('redirect_uri');
    const completeA = a.complete({ timeoutMs: 10_000 });
    await get(`${redirectUri}?code=abc123&state=${state}`);
    await expect(completeA).resolves.toBeUndefined();
    await service.shutdown();
  });

  it('tokenState() reports the absolute expiry when the grant is stamped', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
    }));
    const service = new McpOAuthService({ store });
    seedGrant(store, 'srv', oauthServer.url, {
      access_token: 'old',
      refresh_token: 'rt-1',
      expires_in: 3600,
    });

    const state = await service.tokenState('srv', oauthServer.url);
    expect(state.hasTokens).toBe(true);
    expect(state.hasRefreshToken).toBe(true);
    expect(state.expiresAt).toBeTypeOf('number');
    expect(state.expiresAt).toBeGreaterThan(Date.now());
    expect(state.expired).toBe(false);
    await service.shutdown();
  });

  it('provider writes a meta sidecar alongside saved tokens', async () => {
    oauthServer = await startOAuthServer(() => ({
      status: 200,
      payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
    }));
    const service = new McpOAuthService({ store });
    const provider = service.getProvider('srv', oauthServer.url) as McpOAuthClientProvider;
    await provider.saveTokens({ access_token: 't', token_type: 'Bearer', expires_in: 3600 });

    const metas = await store.list(META_SUFFIX);
    expect(metas).toHaveLength(1);
    const canonicalUrl = `${oauthServer.url}/`;
    expect(await store.read(metas[0]!)).toEqual({
      serverName: 'srv',
      serverUrl: canonicalUrl,
    });
    await service.shutdown();
  });

  it('refresh() skips credentials with an in-flight interactive flow', async () => {
    let tokenCalls = 0;
    oauthServer = await startOAuthServer(() => {
      tokenCalls += 1;
      return {
        status: 200,
        payload: { access_token: 't', token_type: 'Bearer', expires_in: 3600 },
      };
    });
    const service = new McpOAuthService({ store });

    const flow = service.beginAuthorization('srv', oauthServer.url);
    // The interactive flow is in flight (callback listener up): a refresh
    // must not reset the provider's PKCE/redirect state.
    const refresh = service.refresh('srv', oauthServer.url);
    await expect(refresh).resolves.toBeUndefined();
    await flow;
    expect(tokenCalls).toBe(0);
    await service.shutdown();
  });
});