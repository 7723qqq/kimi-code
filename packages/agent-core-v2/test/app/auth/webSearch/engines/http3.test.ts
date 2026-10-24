import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { engineFetch } from '#/app/auth/webSearch/engines/engine-http';
import { undiciFetch } from '#/app/auth/webSearch/engines/engine-undici';
import {
  h3Fetch,
  h3OriginState,
  isBunRuntime,
  markH3Origin,
  resetH3States,
} from '#/app/auth/webSearch/engines/http3';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';
import { setEnv, setGlobal, restoreEnvs, restoreGlobals } from '#test/helpers/stubs';
import { waitForAssertion } from '#test/helpers/waitFor';

void mock.module('#/app/auth/webSearch/engines/engine-undici', () => ({
  undiciFetch: mock(),
}));

const undiciFetchMock = undiciFetch as Mock<typeof undiciFetch>;

interface FakeHostTimerHandle extends IHostTimerHandle {
  readonly id: number;
}

interface TrackedHostTimers extends IHostTimers {
  readonly outstanding: number;
  readonly scheduledDelays: readonly number[];
}

function createTrackedHostTimers(): TrackedHostTimers {
  let nextId = 1;
  const outstanding = new Set<number>();
  const scheduledDelays: number[] = [];

  const schedule = (delayMs: number): FakeHostTimerHandle => {
    const id = nextId++;
    outstanding.add(id);
    scheduledDelays.push(delayMs);
    return { id };
  };

  const release = (handle: IHostTimerHandle): void => {
    outstanding.delete((handle as { id?: number }).id ?? -1);
  };

  return {
    _serviceBrand: undefined,
    setClampedTimeout: (_callback, timeoutMs) => schedule(Math.min(timeoutMs, 2_147_483_647)),
    setTimeout: (_callback, timeoutMs) => schedule(timeoutMs),
    clearTimeout: release,
    get outstanding() {
      return outstanding.size;
    },
    get scheduledDelays() {
      return scheduledDelays;
    },
  };
}

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
      setGlobal('Bun', {});
    }
    undiciFetchMock.mockClear();
    const h3 = mock(async () => new Response('ok', { status: 200 }));
    setGlobal('fetch', h3);
  });

  afterEach(() => {
    restoreGlobals();
    restoreEnvs();
    mock.restore();
  });

  it('uses the cached h3 fast path without touching undici', async () => {
    markH3Origin(ORIGIN, 'ok');
    const r = await engineFetch(URL_);
    expect(r.status).toBe(200);
    expect(undiciFetchMock).not.toHaveBeenCalled();
    const init = (fetch as unknown as Mock<FetchLike>).mock.calls[0]?.[1] as
      | RequestInit
      | undefined;
    expect((init as { protocol?: string })?.protocol).toBe('http3');
  });

  it('leaves no dangling timeout behind the h3 fast path', async () => {
    markH3Origin(ORIGIN, 'ok');
    const timers = createTrackedHostTimers();
    await engineFetch(URL_, { timers });
    expect(timers.scheduledDelays).toEqual([15_000]);
    expect(timers.outstanding).toBe(0);
  });

  it('falls back to undici and marks the origin dead when h3 fails', async () => {
    markH3Origin(ORIGIN, 'ok');
    undiciFetchMock.mockResolvedValue(undiciResponse() as never);
    (fetch as unknown as Mock<FetchLike>).mockRejectedValueOnce(new Error('quic handshake failed'));

    const first = await engineFetch(URL_);
    expect(first.status).toBe(200);
    expect(h3OriginState(ORIGIN)).toBe('dead');

    await engineFetch(URL_);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(undiciFetchMock).toHaveBeenCalledTimes(2);
  });

  it('probes an unknown origin in the background and promotes it after a successful h3 request', async () => {
    undiciFetchMock.mockResolvedValue(undiciResponse() as never);

    await engineFetch(URL_);
    expect(h3OriginState(ORIGIN)).toBe('unknown');

    await waitForAssertion(() => {
      expect(h3OriginState(ORIGIN)).toBe('ok');
    });

    const before = undiciFetchMock.mock.calls.length;
    await engineFetch(URL_);
    expect(undiciFetchMock.mock.calls.length).toBe(before);
    expect(h3OriginState(ORIGIN)).toBe('ok');
  });

  it('respects the KIMI_CODE_SEARCH_H3 kill switch even for ok origins', async () => {
    setEnv('KIMI_CODE_SEARCH_H3', '0');
    markH3Origin(ORIGIN, 'ok');
    undiciFetchMock.mockResolvedValue(undiciResponse() as never);

    const r = await engineFetch(URL_);
    expect(r.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates background probes for concurrent unknown-origin calls', async () => {
    let h3Attempts = 0;
    undiciFetchMock.mockResolvedValue(undiciResponse() as never);
    setGlobal(
      'fetch',
      mock(async () => {
        h3Attempts++;
        await new Promise((r) => setTimeout(r, 30));
        return new Response('ok', { status: 200 });
      }),
    );

    await Promise.all([engineFetch(URL_), engineFetch(URL_)]);
    await waitForAssertion(() => expect(h3OriginState(ORIGIN)).toBe('ok'));

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
    restoreGlobals();
    restoreEnvs();
  });

  it('exempts the target host from proxy env while an h3 request is in flight', async () => {
    setEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    let seenNoProxy: string | undefined;
    setGlobal(
      'fetch',
      mock(async () => {
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
    setEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    setEnv('NO_PROXY', 'internal.example,*.corp.example');
    setGlobal(
      'fetch',
      mock(async () => new Response('ok', { status: 200 })),
    );

    await h3Fetch('https://h3.test/', { timeoutMs: 1000 });

    expect(process.env['NO_PROXY']).toBe('internal.example,*.corp.example');
    expect(process.env['no_proxy']).toBe(
      process.platform === 'win32' ? 'internal.example,*.corp.example' : undefined,
    );
  });

  it('keeps earlier hosts exempt until their own concurrent calls finish', async () => {
    setEnv('HTTPS_PROXY', 'http://proxy.example:8080');
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: (string | undefined)[] = [];
    setGlobal(
      'fetch',
      mock(async (_url: string | URL) => {
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
