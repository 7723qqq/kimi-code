import { describe, expect, it, mock } from 'bun:test';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';
import { waitUntil } from '#test/helpers/waitFor';

interface FakeHostTimerHandle extends IHostTimerHandle {
  readonly id: number;
}

interface TrackedHostTimers extends IHostTimers {
  advanceAsync(byMs: number): Promise<void>;
  readonly outstanding: number;
}

async function flushTimersWork(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function createTrackedHostTimers(): TrackedHostTimers {
  let nowMs = 0;
  let nextId = 1;
  const scheduled: Array<{
    readonly id: number;
    readonly due: number;
    readonly callback: () => void;
    cleared: boolean;
  }> = [];

  const schedule = (callback: () => void, delayMs: number): FakeHostTimerHandle => {
    const entry = { id: nextId++, due: nowMs + Math.max(delayMs, 0), callback, cleared: false };
    scheduled.push(entry);
    return { id: entry.id };
  };

  return {
    _serviceBrand: undefined,
    setClampedTimeout: (callback, timeoutMs) =>
      schedule(callback, Math.min(timeoutMs, 2_147_483_647)),
    setTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    clearTimeout: (handle) => {
      const id = (handle as { id?: number }).id;
      const entry = scheduled.find((candidate) => candidate.id === id);
      if (entry !== undefined) entry.cleared = true;
    },
    advanceAsync: async (byMs) => {
      await flushTimersWork();
      const limit = nowMs + byMs;
      for (;;) {
        const next = scheduled
          .filter((entry) => !entry.cleared && entry.due <= limit)
          .toSorted((left, right) => left.due - right.due || left.id - right.id)[0];
        if (next === undefined) break;
        nowMs = next.due;
        next.callback();
        await flushTimersWork();
      }
      nowMs = limit;
      await flushTimersWork();
    },
    get outstanding() {
      return scheduled.filter((entry) => !entry.cleared).length;
    },
  };
}

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('LocalFetchURLProvider requests', () => {
  it('fetches a loopback IPv4 literal', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('http://127.0.0.1:1337/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches an IPv4-mapped IPv6 literal', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('http://[::ffff:127.0.0.1]/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches localhost and *.localhost aliases', async () => {
    const fetchImpl = mock<FetchLike>().mockImplementation(
      async () => htmlResponse('local', 'text/plain'),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('http://localhost:1337/');
    await provider.fetch('http://app.localhost/');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fetches a hostname without a separate DNS safety check', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValue(htmlResponse('local', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('http://localtest.me/');

    expect(result.content).toBe('local');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localtest.me/',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('propagates fetch network errors', async () => {
    const fetchImpl = mock<FetchLike>().mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND b0rked.example'),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('http://b0rked.example/')).rejects.toThrow(
      'getaddrinfo ENOTFOUND b0rked.example',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects non-http(s) schemes before any network access', async () => {
    const fetchImpl = mock<FetchLike>();
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('file:///etc/passwd')).rejects.toThrow('Unsupported URL scheme');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches public hosts normally', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValue(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/');

    expect(result.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('LocalFetchURLProvider redirects', () => {
  it('follows a redirect manually', async () => {
    const fetchImpl = mock<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/page' },
        }),
      )
      .mockResolvedValueOnce(htmlResponse('final body', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/start');

    expect(result.content).toBe('final body');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, firstInit] = fetchImpl.mock.calls[0]!;
    expect((firstInit as RequestInit).redirect).toBe('manual');
  });

  it('resolves relative redirect targets against the current URL', async () => {
    const fetchImpl = mock<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/final' } }))
      .mockResolvedValueOnce(htmlResponse('ok', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await provider.fetch('https://example.com/start');

    const [secondUrl] = fetchImpl.mock.calls[1]!;
    expect(secondUrl).toBe('https://example.com/final');
  });

  it('follows a redirect to a private IP literal', async () => {
    const fetchImpl = mock<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
      )
      .mockResolvedValueOnce(htmlResponse('metadata', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/start');

    expect(result.content).toBe('metadata');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe('http://169.254.169.254/latest/meta-data');
  });

  it('follows a redirect to an internal hostname', async () => {
    const fetchImpl = mock<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example.com/' },
        }),
      )
      .mockResolvedValueOnce(htmlResponse('internal', 'text/plain'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/');

    expect(result.content).toBe('internal');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = mock<FetchLike>().mockImplementation(
      async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/loop')).rejects.toThrow('Too many redirects');
    expect(fetchImpl).toHaveBeenCalledTimes(11);
  });

  it('treats a redirect response without a Location header as final', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValueOnce(
      new Response('odd', { status: 302, headers: { 'content-type': 'text/plain' } }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/odd');

    expect(result.content).toBe('odd');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('LocalFetchURLProvider responses', () => {
  it('rejects oversized responses by content-length', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValue(
      new Response('short', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'content-length': String(11 * 1024 * 1024),
        },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    await expect(provider.fetch('https://example.com/big')).rejects.toThrow(
      'Response body too large',
    );
  });
});

describe('LocalFetchURLProvider timeouts and streaming caps', () => {
  function hungResponse(): (url: unknown, init?: RequestInit) => Promise<Response> {
    return (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
      }) as Promise<Response>;
  }

  it('reports a timed-out error when the server hangs past the shared deadline', async () => {
    const timers = createTrackedHostTimers();
    const fetchImpl = mock<FetchLike>(hungResponse());
    const provider = new LocalFetchURLProvider({ fetchImpl, timeoutMs: 1000, timers });
    const settled = provider.fetch('https://example.com/').then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await timers.advanceAsync(1000);
    const error = await settled;
    expect((error as Error).message).toContain('timed out after 1000ms');
    expect(timers.outstanding).toBe(0);
  });

  it('propagates a caller abort during a hang instead of reporting a timeout', async () => {
    const caller = new AbortController();
    const fetchImpl = mock<FetchLike>(hungResponse());
    const provider = new LocalFetchURLProvider({ fetchImpl, timeoutMs: 60_000 });

    const settled = provider.fetch('https://example.com/', { signal: caller.signal }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await waitUntil(() => fetchImpl.mock.calls.length > 0);
    caller.abort();
    const error = await settled;
    expect((error as Error).message).toContain('The operation was aborted.');
  });

  it('rejects an oversized chunked response while streaming, before buffering it', async () => {
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount <= 100) {
          controller.enqueue(new Uint8Array(100).fill(0x61));
        } else {
          controller.close();
        }
      },
    });
    const fetchImpl = mock<FetchLike>().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl, maxBytes: 1000 });

    await expect(provider.fetch('https://example.com/chunked')).rejects.toThrow(
      'Response body too large',
    );
    expect(pullCount).toBeLessThan(30);
  });
});
