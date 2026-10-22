import { describe, expect, it, mock } from 'bun:test';

import { refreshProviderModels } from '../src/refreshProviderModels';
import type { ManagedKimiConfigShape, RefreshProviderHost } from '../src';
import { setGlobal, restoreGlobals } from './stubs';

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

    setGlobal(
      'fetch',
      mock(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    try {
      const result = await refreshProviderModels(host, {});

      expect(result.changed).toEqual([]);
      expect(result.failed.map((entry) => entry.provider)).toEqual(['moonshot-cn']);
      expect(result.failed[0]?.reason).toContain('no models');
      expect(saved).toEqual([]);
    } finally {
      restoreGlobals();
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

    setGlobal(
      'fetch',
      mock(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    try {
      const result = await refreshProviderModels(host, { providerId: 'managed:kimi-code' });

      expect(
        result.failed.some((entry) => entry.reason.includes('no models')),
        JSON.stringify(result.failed),
      ).toBe(true);
    } finally {
      restoreGlobals();
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

    setGlobal(
      'fetch',
      mock(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    try {
      const result = await refreshProviderModels(host, { scope: 'oauth' });

      expect(
        result.failed.some((entry) => entry.reason.includes('No models available for Kimi Code')),
        JSON.stringify(result.failed),
      ).toBe(true);
    } finally {
      restoreGlobals();
    }
  });
});

describe('refreshProviderModels open-platform fetch deadline', () => {
  it('gives up on a hung /models fetch and reports the provider as failed', async () => {
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

    function hungFetch(_url: string, init?: RequestInit): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    setGlobal('fetch', mock(hungFetch));
    try {
      const startedAt = Date.now();
      const result = await refreshProviderModels(host, { timeoutMs: 50 });
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(5_000);
      expect(result.changed).toEqual([]);
      expect(result.unchanged).toEqual([]);
      expect(result.failed.map((entry) => entry.provider)).toEqual(['moonshot-cn']);
      expect(result.failed[0]?.reason).toMatch(/abort|timed out/i);
      expect(saved).toEqual([]);
    } finally {
      restoreGlobals();
    }
  });

  it('reports the provider as failed when the caller aborts the refresh', async () => {
    const { host, saved } = hostFor({
      providers: {
        'moonshot-ai': {
          type: 'kimi',
          baseUrl: 'https://api.moonshot.ai/v1',
          apiKey: 'sk-test',
        },
      },
      models: {},
    } as unknown as ManagedKimiConfigShape);

    const controller = new AbortController();
    setGlobal(
      'fetch',
      mock(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                reject(init.signal?.reason);
              },
              { once: true },
            );
          }),
      ),
    );
    try {
      setTimeout(() => {
        controller.abort();
      }, 20);
      const result = await refreshProviderModels(host, {
        signal: controller.signal,
        timeoutMs: 60_000,
      });

      expect(result.failed.map((entry) => entry.provider)).toEqual(['moonshot-ai']);
      expect(result.failed[0]?.reason).toContain('abort');
      expect(saved).toEqual([]);
    } finally {
      restoreGlobals();
    }
  });
});
