/**
 * Scenario: the **auth → modelCatalog** slice — a device-code OAuth login
 * followed by a managed `/models` refresh, with both steps observed through
 * `config.onDidChangeConfiguration`.
 *
 * This example exists to make one design point concrete: **the caller never
 * hand-rolls a `/models` request.** The flow is split into two internal,
 * config-driven steps, and the caller reacts to config changes instead of
 * plumbing model lists around:
 *
 *  1. **Login writes a credential, not models.** `IOAuthService.startLogin`
 *     drives the device-code flow; on success `OAuthService` only provisions
 *     the provider credential (the OAuth ref) into the `providers` config
 *     section. That write fires `config.onDidChangeConfiguration('providers')`, which the
 *     `provider` domain forwards as `providerService.onDidChangeProviders`. `auth` does
 *     not know about `modelCatalog` — dependency direction stays one-way
 *     (`modelCatalog` → `auth`, never the reverse).
 *  2. **Refresh pulls `/models` internally and merges it into config.**
 *     `IOAuthService.refreshOAuthProviderModels` resolves the OAuth
 *     token through `IOAuthService`, fetches the managed model list, and
 *     writes the result into the `models` / `providers` / `defaultModel`
 *     sections through `IConfigService` — each firing `onDidChangeConfiguration`. The caller
 *     *triggers* the refresh explicitly (it is not auto-chained inside login),
 *     then observes the new aliases arrive through config.
 *
 * Everything runs against the real App-scope Services **and** the real OAuth
 * clients — `KimiOAuthToolkit` (device-code protocol + token persistence) and
 * `fetchManagedKimiCodeModels` (the `/models` request) are not stubbed. The
 * only thing faked is the wire itself: `globalThis.fetch` is replaced with a
 * tiny URL/method router that answers the OAuth device-code endpoints and the
 * `/models` endpoint. No server listens on any port; the clients construct real
 * requests and read real `Response` objects, so the request / response shapes
 * (headers, snake_case wire, status-code branches) are exercised for real.
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Scope } from '#/_base/di/scope';
import { IOAuthService } from '#/app/auth';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config';
import { logSeed, resolveLoggingConfig } from '#/app/log/logConfig';
import { IModelService } from '#/app/model';
import { IProviderService } from '#/app/provider';
import '#/app/storage';
import '#/app/telemetry';

const STUB_ACCESS_TOKEN = 'stub-access-token';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Replace `globalThis.fetch` with a router that answers exactly the three
 * requests this slice issues: device authorization, device-code token polling,
 * and the managed `/models` listing. Anything else throws so an unexpected call
 * is loud instead of silently hitting the network.
 */
function installFetchMock(): void {
  const router = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const path = new URL(url).pathname;

    if (method === 'POST' && path.endsWith('/api/oauth/device_authorization')) {
      return jsonResponse(200, {
        user_code: 'STUB-USER-CODE',
        device_code: 'stub-device-code',
        verification_uri: 'https://example.com/device',
        verification_uri_complete: 'https://example.com/device?code=STUB-USER-CODE',
        expires_in: 900,
        interval: 0,
      });
    }

    if (method === 'POST' && path.endsWith('/api/oauth/token')) {
      return jsonResponse(200, {
        access_token: STUB_ACCESS_TOKEN,
        refresh_token: 'stub-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: '',
      });
    }

    if (method === 'GET' && path.endsWith('/models')) {
      return jsonResponse(200, {
        data: [
          {
            id: 'k2-thinking',
            context_length: 262_144,
            supports_reasoning: true,
            supports_image_in: false,
            supports_video_in: false,
            supports_thinking_type: 'both',
            display_name: 'K2 Thinking',
          },
          {
            id: 'k2',
            context_length: 131_072,
            supports_reasoning: false,
            supports_image_in: false,
            supports_video_in: false,
          },
        ],
      });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  vi.stubGlobal('fetch', router);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error('waitUntil timed out');
}

describe('oauth → modelCatalog slice (request-layer fetch mock, real clients)', () => {
  let homeDir: string;
  let caseDir: string;
  let app: Scope | undefined;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    // The real `KimiOAuthToolkit` persists tokens to `{homeDir}/credentials`;
    // give each test its own home so a token saved by one test cannot make the
    // next test look "already authenticated" and skip the device-code flow.
    caseDir = join(homeDir, randomUUID());
    mkdirSync(caseDir, { recursive: true });
    installFetchMock();
  });

  afterEach(() => {
    app?.dispose();
    app = undefined;
    vi.unstubAllGlobals();
  });

  function buildApp(): Scope {
    return bootstrap(
      { homeDir: caseDir },
      logSeed(resolveLoggingConfig({ homeDir: caseDir, env: process.env })),
    ).app;
  }

  test('device-code login provisions the provider credential through config.onDidChangeConfiguration', async () => {
    app = buildApp();
    const config = app.accessor.get(IConfigService);
    const oauth = app.accessor.get(IOAuthService);
    const providers = app.accessor.get(IProviderService);
    await config.ready;
    providers.list();

    const changed: string[] = [];
    const sub = config.onDidChangeConfiguration((e) => changed.push(e.domain));

    const start = await oauth.startLogin();
    console.log('device code issued:', start.user_code, '→', start.verification_uri);
    expect(start.status).toBe('pending');

    // The credential lands asynchronously: handleSuccess provisions the
    // provider after the device-code promise resolves. Wait for the OAuth ref
    // to appear in config rather than for the flow status, so the config write
    // is guaranteed to have committed.
    await waitUntil(() => providers.get(KIMI_CODE_PROVIDER_NAME)?.oauth !== undefined);
    sub.dispose();

    const provider = providers.get(KIMI_CODE_PROVIDER_NAME);
    console.log('provisioned provider:', JSON.stringify(provider));
    console.log('config domains changed by login:', changed);

    expect(provider?.oauth).toBeDefined();
    expect(changed).toContain('providers');
    expect(await oauth.status()).toEqual({ loggedIn: true, provider: KIMI_CODE_PROVIDER_NAME });
  });

  test('refreshOAuthProviderModels fetches /models internally and lands aliases through config.onDidChangeConfiguration', async () => {
    app = buildApp();
    const config = app.accessor.get(IConfigService);
    const oauth = app.accessor.get(IOAuthService);
    const providers = app.accessor.get(IProviderService);
    const models = app.accessor.get(IModelService);
    await config.ready;
    providers.list();

    // Login first so the provider holds an OAuth ref; the refresh resolves the
    // token from that ref. The caller triggers the refresh explicitly — login
    // does not auto-fetch models.
    await oauth.startLogin();
    await waitUntil(() => providers.get(KIMI_CODE_PROVIDER_NAME)?.oauth !== undefined);

    const changed: string[] = [];
    const sub = config.onDidChangeConfiguration((e) => changed.push(e.domain));
    const result = await oauth.refreshOAuthProviderModels();
    sub.dispose();

    const aliases = models.list();
    console.log('refresh result:', JSON.stringify(result));
    console.log('config domains changed by refresh:', changed);
    console.log('model aliases after refresh:', Object.keys(aliases));
    console.log('defaultModel:', config.get('defaultModel'));

    expect(result.failed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]).toMatchObject({ provider_id: KIMI_CODE_PROVIDER_NAME, added: 2 });

    // `applyManagedKimiCodeConfig` keys aliases as `kimi-code/<model id>`.
    expect(aliases['kimi-code/k2-thinking']).toMatchObject({
      provider: KIMI_CODE_PROVIDER_NAME,
      model: 'k2-thinking',
      displayName: 'K2 Thinking',
    });
    expect(aliases['kimi-code/k2']).toBeDefined();

    // Models arrived through config, not through a caller-threaded return value.
    expect(changed).toContain('models');
    expect(changed).toContain('defaultModel');
    expect(config.get('defaultModel')).toBe('kimi-code/k2-thinking');
  });
});
