import { describe, expect, it, vi } from 'vitest';

import { refreshProviderModels } from '../src/refreshProviderModels';
import type { ManagedKimiConfigShape, RefreshProviderHost } from '../src';

function hostFor(config: ManagedKimiConfigShape): {
  host: RefreshProviderHost;
  saved: ManagedKimiConfigShape[];
} {
  const saved: ManagedKimiConfigShape[] = [];
  let current = config;
  return {
    saved,
    host: {
      getConfig: async () => current,
      removeProvider: async () => current,
      setConfig: async (patch) => {
        saved.push(patch);
        current = { ...current, ...patch };
        return current;
      },
      resolveOAuthToken: async () => 'token',
    },
  };
}

describe('refreshProviderModels bucket reporting', () => {
  it('reports an open-platform provider with no API key as failed, not as silence', async () => {
    const { host, saved } = hostFor({
      providers: {
        'moonshot-cn': { type: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' },
      },
      models: {},
    } as unknown as ManagedKimiConfigShape);

    const result = await refreshProviderModels(host, {});

    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.failed.map((entry) => entry.provider)).toEqual(['moonshot-cn']);
    expect(result.failed[0]?.reason).toContain('no API key');
    expect(saved).toEqual([]);
  });

  it('reports a provider that returned no models as failed', async () => {
    const { host, saved } = hostFor({
      providers: {
        'moonshot-cn': {
          type: 'kimi',
          baseUrl: 'https://api.moonshot.cn/v1',
          apiKey: 'sk-test',
        },
      },
      models: {},
    } as unknown as ManagedKimiConfigShape);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    try {
      const result = await refreshProviderModels(host, {});

      expect(result.changed).toEqual([]);
      expect(result.failed.map((entry) => entry.provider)).toEqual(['moonshot-cn']);
      expect(result.failed[0]?.reason).toContain('no models');
      expect(saved).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports the managed provider with no models as failed', async () => {
    const { host } = hostFor({
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          baseUrl: 'https://api.kimi.com/coding/v1',
          apiKey: 'sk-test',
        },
      },
      models: {},
    } as unknown as ManagedKimiConfigShape);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    try {
      const result = await refreshProviderModels(host, { providerId: 'managed:kimi-code' });

      expect(
        result.failed.some((entry) => entry.reason.includes('no models')),
        JSON.stringify(result.failed),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports the OAuth managed provider with no models as failed', async () => {
    const { host } = hostFor({
      providers: {
        'managed:kimi-code': {
          type: 'kimi',
          baseUrl: 'https://api.kimi.com/coding/v1',
          oauth: { key: 'managed', oauthHost: 'https://api.kimi.com' },
        },
      },
      models: {},
    } as unknown as ManagedKimiConfigShape);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    try {
      const result = await refreshProviderModels(host, { scope: 'oauth' });

      expect(
        result.failed.some((entry) => entry.reason.includes('No models available for Kimi Code')),
        JSON.stringify(result.failed),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
