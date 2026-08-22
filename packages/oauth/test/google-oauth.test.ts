import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyGoogleGeminiConfig,
  GOOGLE_GEMINI_DEFAULT_MODELS,
  GOOGLE_GEMINI_PROVIDER_ID,
  GoogleOAuthManager,
} from '../src';
import type { ManagedKimiConfigShape } from '../src';

describe('Google OAuth & Gemini Module', () => {
  let tmpDir: string;
  let manager: GoogleOAuthManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'google-oauth-test-'));
    vi.spyOn(GoogleOAuthManager, 'detectAntigravityCredentials').mockReturnValue({ available: false });
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
});
