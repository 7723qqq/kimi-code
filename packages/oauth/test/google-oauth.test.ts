import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  applyGoogleGeminiConfig,
  GOOGLE_DEFAULT_CLIENT_ID,
  GOOGLE_DEFAULT_CLIENT_SECRET,
  GOOGLE_GEMINI_DEFAULT_MODELS,
  GOOGLE_GEMINI_PROVIDER_ID,
  GoogleOAuthManager,
  OAuthError,
  OAuthUnauthorizedError,
} from '../src';
import type { ManagedKimiConfigShape } from '../src';
import { setGlobal, restoreGlobals } from './stubs';

describe('Google OAuth & Gemini Module', () => {
  let tmpDir: string;
  let manager: GoogleOAuthManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'google-oauth-test-'));
    spyOn(GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({
      available: false,
    });
    manager = new GoogleOAuthManager({ credentialsDir: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mock.restore();
    restoreGlobals();
  });

  it('saves and loads Google OAuth token info', async () => {
    expect(await manager.hasToken()).toBe(false);
    expect(await manager.getValidAccessToken()).toBeUndefined();

    const token = {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      scope: 'https://www.googleapis.com/auth/generative-language',
      tokenType: 'Bearer',
      expiresIn: 3600,
    };

    await manager.saveToken(token);
    expect(await manager.hasToken()).toBe(true);

    const loaded = await manager.loadToken();
    expect(loaded).toEqual(token);

    const validToken = await manager.getValidAccessToken();
    expect(validToken).toBe('test-access-token');

    await manager.logout();
    expect(await manager.hasToken()).toBe(false);
  });

  it('automatically refreshes token when close to expiration', async () => {
    const expiredToken = {
      accessToken: 'expired-access-token',
      refreshToken: 'valid-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 60, // expires in 60s (< 300s buffer)
      scope: 'https://www.googleapis.com/auth/generative-language',
      tokenType: 'Bearer',
      expiresIn: 60,
    };
    await manager.saveToken(expiredToken);

    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-refreshed-access-token',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
    });
    setGlobal('fetch', fetchMock);

    const token = await manager.getValidAccessToken();
    expect(token).toBe('new-refreshed-access-token');
    expect(fetchMock).toHaveBeenCalled();

    const loaded = await manager.loadToken();
    expect(loaded?.accessToken).toBe('new-refreshed-access-token');
    expect(loaded?.refreshToken).toBe('valid-refresh-token');

    const [, requestInit] = fetchMock.mock.calls[0]! as [string, RequestInit];
    const rawBody = requestInit.body;
    if (typeof rawBody !== 'string') throw new Error('expected string request body');
    const body = new URLSearchParams(rawBody);
    expect(body.get('client_id')).toBe(GOOGLE_DEFAULT_CLIENT_ID);
    // A missing secret makes Google reject the refresh with 401 invalid_client.
    expect(body.get('client_secret')).toBe(GOOGLE_DEFAULT_CLIENT_SECRET);
    expect((body.get('client_secret') ?? '').length).toBeGreaterThan(0);
  });

  it('applies Google Gemini configuration to ManagedKimiConfigShape', () => {
    const config: ManagedKimiConfigShape = {
      providers: {},
      models: {},
    };

    const result = applyGoogleGeminiConfig(config, {
      authType: 'oauth',
      models: GOOGLE_GEMINI_DEFAULT_MODELS,
      selectedModel: 'gemini-2.5-pro',
      thinking: true,
      effort: 'high',
    });

    expect(result.defaultModel).toBe('google-gemini/gemini-2.5-pro');
    expect(config.providers[GOOGLE_GEMINI_PROVIDER_ID]).toBeDefined();
    expect(config.providers[GOOGLE_GEMINI_PROVIDER_ID]?.type).toBe('google-genai');
    expect(config.models?.[`google-gemini/gemini-2.5-pro`]).toBeDefined();
    expect(config.models?.[`google-gemini/gemini-2.5-flash`]).toBeDefined();
    expect(config.thinking?.enabled).toBe(true);
    expect(config.thinking?.effort).toBe('high');
  });

  it('throws OAuthUnauthorizedError instead of returning a stale token when refresh fails', async () => {
    await manager.saveToken({
      accessToken: 'stale-access-token',
      refreshToken: 'dead-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 60,
    });

    spyOn(console, 'warn').mockImplementation(() => {});
    setGlobal(
      'fetch',
      mock().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' }),
    );

    await expect(manager.getValidAccessToken()).rejects.toThrow(OAuthUnauthorizedError);
    await expect(manager.getValidAccessToken()).rejects.toThrow(/run \/login/);
  });

  it('coalesces concurrent getValidAccessToken calls into one refresh', async () => {
    await manager.saveToken({
      accessToken: 'near-expiry-token',
      refreshToken: 'valid-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 60,
    });

    const fetchMock = mock().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        refresh_token: 'valid-refresh-token',
        expires_in: 7200,
      }),
    });
    setGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      manager.getValidAccessToken(),
      manager.getValidAccessToken(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe('refreshed-token');
    expect(b).toBe('refreshed-token');
  });

  it('does not let a stale Antigravity file destroy a working credential', async () => {
    await manager.saveToken({
      accessToken: 'my-access-token',
      refreshToken: 'valid-refresh-token',
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 60,
    });

    // The Antigravity file exists but holds an EXPIRED token, and it has no
    // refresh token of its own. Importing it must not reach storage.
    const credsPath = join(tmpDir, 'oauth_creds.json');
    writeFileSync(
      credsPath,
      JSON.stringify({
        access_token: 'stale-imported-token',
        expiry_date: Date.now() - 60_000,
      }),
    );
    spyOn(GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({
      available: true,
      credsPath,
    });

    spyOn(console, 'warn').mockImplementation(() => {});
    setGlobal(
      'fetch',
      mock().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' }),
    );

    await expect(manager.getValidAccessToken()).rejects.toThrow(OAuthUnauthorizedError);

    const stored = await manager.loadToken();
    expect(stored?.refreshToken).toBe('valid-refresh-token');
    expect(stored?.accessToken).toBe('my-access-token');
  });

  it('propagates the failure reason from importAntigravityCredentials', async () => {
    const missingPath = join(tmpDir, 'missing', 'oauth_creds.json');
    spyOn(GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({
      available: true,
      credsPath: missingPath,
    });

    await expect(manager.importAntigravityCredentials()).rejects.toThrow(OAuthError);
    await expect(manager.importAntigravityCredentials()).rejects.toThrow(missingPath);
  });

  it('refuses to construct without a home directory', () => {
    const previous = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      KIMI_CODE_HOME: process.env['KIMI_CODE_HOME'],
    };
    delete process.env['HOME'];
    delete process.env['USERPROFILE'];
    delete process.env['KIMI_CODE_HOME'];
    try {
      expect(() => new GoogleOAuthManager()).toThrow(/home directory/i);
    } finally {
      if (previous.HOME !== undefined) process.env['HOME'] = previous.HOME;
      if (previous.USERPROFILE !== undefined) process.env['USERPROFILE'] = previous.USERPROFILE;
      if (previous.KIMI_CODE_HOME !== undefined) {
        process.env['KIMI_CODE_HOME'] = previous.KIMI_CODE_HOME;
      }
    }
  });
});
