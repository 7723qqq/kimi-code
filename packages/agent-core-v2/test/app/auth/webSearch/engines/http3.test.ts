import { afterEach, beforeEach, describe, expect, vi, it } from 'vitest';

import { engineFetch } from '#/app/auth/webSearch/engines/engine-http';
import { undiciFetch as undiciFetchMock } from '#/app/auth/webSearch/engines/engine-undici';
import {
  h3Fetch,
  h3OriginState,
  isBunRuntime,
  markH3Origin,
  resetH3States,
} from '#/app/auth/webSearch/engines/http3';

vi.mock('#/app/auth/webSearch/engines/engine-undici', () => ({
  undiciFetch: vi.fn(),
}));

const ORIGIN = 'https://h3.test';
const URL_ = 'https://h3.test/search?q=x';

function undiciResponse(extraHeaders: Record<string, string> = {}): {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  stream: () => null;
  headers: Headers;
} {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '<html></html>',
    stream: () => null,
    headers: new Headers(extraHeaders),
  };
}

describe('engineFetch http3 adaptation', () => {
  beforeEach(() => {
    resetH3States();
    if (!isBunRuntime()) {
      vi.stubGlobal('Bun', {});
    }
    vi.mocked(undiciFetchMock).mockClear();
    const h3 = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', h3);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses the cached h3 fast path without touching undici', async () => {
    markH3Origin(ORIGIN, 'ok');
    const r = await engineFetch(URL_);
    expect(r.status).toBe(200);
    expect(vi.mocked(undiciFetchMock)).not.toHaveBeenCalled();
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init as { protocol?: string })?.protocol).toBe('http3');
  });

  it('leaves no dangling timeout behind the h3 fast path', async () => {
    markH3Origin(ORIGIN, 'ok');
    vi.useFakeTimers();
    try {
      await engineFetch(URL_);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to undici and marks the origin dead when h3 fails', async () => {
    markH3Origin(ORIGIN, 'ok');
    vi.mocked(undiciFetchMock).mockResolvedValue(undiciResponse() as never);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('quic handshake failed'));

    const first = await engineFetch(URL_);
    expect(first.status).toBe(200);
    expect(h3OriginState(ORIGIN)).toBe('dead');

    await engineFetch(URL_);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(undiciFetchMock)).toHaveBeenCalledTimes(2);
  });

  it('probes an unknown origin in the background and promotes it after a successful h3 request', async () => {
    vi.mocked(undiciFetchMock).mockResolvedValue(undiciResponse() as never);

    await engineFetch(URL_);
    expect(h3OriginState(ORIGIN)).toBe('unknown');

    await vi.waitFor(() => {
      expect(h3OriginState(ORIGIN)).toBe('ok');
    });

    const before = vi.mocked(undiciFetchMock).mock.calls.length;
    await engineFetch(URL_);
    expect(vi.mocked(undiciFetchMock).mock.calls.length).toBe(before);
    expect(h3OriginState(ORIGIN)).toBe('ok');
  });

  it('respects the KIMI_CODE_SEARCH_H3 kill switch even for ok origins', async () => {
    vi.stubEnv('KIMI_CODE_SEARCH_H3', '0');
    markH3Origin(ORIGIN, 'ok');
    vi.mocked(undiciFetchMock).mockResolvedValue(undiciResponse() as never);

    const r = await engineFetch(URL_);
    expect(r.status).toBe(200);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(undiciFetchMock)).toHaveBeenCalledOnce();
  });

  it('deduplicates background probes for concurrent unknown-origin calls', async () => {
    let h3Attempts = 0;
    vi.mocked(undiciFetchMock).mockResolvedValue(undiciResponse() as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        h3Attempts++;
        await new Promise((r) => setTimeout(r, 30));
        return new Response('ok', { status: 200 });
      }),
    );

    await Promise.all([engineFetch(URL_), engineFetch(URL_)]);
    await vi.waitFor(() => expect(h3OriginState(ORIGIN)).toBe('ok'));

    expect(h3Attempts).toBe(1);
  });
});

describe('h3Fetch direct routing behind a proxy', () => {
  const savedProxyEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetH3States();
    for (const key of ['NO_PROXY', 'no_proxy'] as const) {
      savedProxyEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ['NO_PROXY', 'no_proxy'] as const) {
      const saved = savedProxyEnv[key];
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('exempts the target host from proxy env while an h3 request is in flight', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    let seenNoProxy: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        seenNoProxy = process.env['NO_PROXY'];
        return new Response('ok', { status: 200 });
      }),
    );

    await h3Fetch('https://h3.test/search?q=x', { timeoutMs: 1000 });

    expect(seenNoProxy).toContain('h3.test');
    expect(process.env['NO_PROXY']).toBeUndefined();
    expect(process.env['no_proxy']).toBeUndefined();
  });

  it('restores a pre-existing NO_PROXY verbatim afterwards', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    vi.stubEnv('NO_PROXY', 'internal.example,*.corp.example');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));

    await h3Fetch('https://h3.test/', { timeoutMs: 1000 });

    expect(process.env['NO_PROXY']).toBe('internal.example,*.corp.example');
    expect(process.env['no_proxy']).toBe(
      process.platform === 'win32' ? 'internal.example,*.corp.example' : undefined,
    );
  });

  it('keeps earlier hosts exempt until their own concurrent calls finish', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: (string | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL) => {
        snapshots.push(process.env['NO_PROXY']);
        if (snapshots.length === 1) await gate;
        return new Response('ok', { status: 200 });
      }),
    );

    const first = h3Fetch('https://a.test/', { timeoutMs: 5000 });
    const second = h3Fetch('https://b.test/', { timeoutMs: 5000 });
    await second;
    expect(snapshots[1]).toContain('a.test');
    expect(snapshots[1]).toContain('b.test');

    releaseFirst();
    await first;
    expect(process.env['NO_PROXY']).toBeUndefined();
  });
});
