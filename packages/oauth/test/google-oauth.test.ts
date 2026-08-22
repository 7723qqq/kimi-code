import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyGoogleGeminiConfig,
  GOOGLE_GEMINI_DEFAULT_MODELS,
  GOOGLE_GEMINI_PROVIDER_ID,
  GoogleOAuthManager,
  OAuthError,
  OAuthUnauthorizedError,
} from '../src';
import type { ManagedKimiConfigShape } from '../src';

describe('Google OAuth & Gemini Module', () => {
  let tmpDir: string;
  let manager: GoogleOAuthManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'google-oauth-test-'));
    vi.spyOn(GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({
      available: false,
    });
    manager = new GoogleOAuthManager({ credentialsDir: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
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

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-refreshed-access-token',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await manager.getValidAccessToken();
    expect(token).toBe('new-refreshed-access-token');
    expect(fetchMock).toHaveBeenCalled();

    const loaded = await manager.loadToken();
    expect(loaded?.accessToken).toBe('new-refreshed-access-token');
    expect(loaded?.refreshToken).toBe('valid-refresh-token');
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

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' }),
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

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-token',
        refresh_token: 'valid-refresh-token',
        expires_in: 7200,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      manager.getValidAccessToken(),
      manager.getValidAccessToken(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe('refreshed-token');
    expect(b).toBe('refreshed-token');
  });

  it('propagates the failure reason from importAntigravityCredentials', async () => {
    const missingPath = join(tmpDir, 'missing', 'oauth_creds.json');
    vi.spyOn(GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({
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
