import { afterEach, beforeEach, describe, expect, vi, it } from 'vitest';

import { fetch as undiciFetchMock } from 'undici';

import { engineFetch } from '#/app/auth/webSearch/engines/engine-http';
import {
  h3OriginState,
  markH3Origin,
  resetH3States,
} from '#/app/auth/webSearch/engines/http3';

vi.mock('undici', () => ({
  fetch: vi.fn(),
  ProxyAgent: class {},
  Agent: class {},
  buildConnector: vi.fn(),
  EnvHttpProxyAgent: class {},
  setGlobalDispatcher: vi.fn(),
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
    vi.stubGlobal('Bun', {});
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
