import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, mock } from 'bun:test';

import type { FetchLike } from '#/_base/utils/fetchLike';
import { rankPassages, WebCache } from '#/app/web/cache/webCache';
import { LocalFetchURLProvider } from '#/app/web/providers/local-fetch-url';
import { extractPdfText } from '#/app/web/providers/pdf-extract';
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

function buildMinimalPdf(streamContent: string, compress: boolean): Uint8Array {
  const payload = compress ? deflateSync(Buffer.from(streamContent, 'latin1')) : Buffer.from(streamContent, 'latin1');
  const dict = compress ? '<< /Filter /FlateDecode >>' : '<< >>';
  const header = Buffer.from('%PDF-1.4\n1 0 obj\n' + dict + '\nstream\n', 'latin1');
  const footer = Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1');
  return Buffer.concat([header, payload, footer]);
}

describe('LocalFetchURLProvider rich formats, query extraction, and WebCache', () => {
  it('pretty-prints application/json responses as passthrough', async () => {
    const fetchImpl = mock<FetchLike>().mockResolvedValue(
      new Response('{"name":"kimi","features":["search","cache"]}', {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://api.example.com/info.json');

    expect(result.kind).toBe('passthrough');
    expect(result.content).toBe('{\n  "name": "kimi",\n  "features": [\n    "search",\n    "cache"\n  ]\n}');
  });

  it('extracts text from uncompressed and FlateDecode PDF streams', async () => {
    const plainPdf = buildMinimalPdf('BT /F1 12 Tf 72 720 Td (Hello Plain PDF) Tj ET', false);
    const compressedPdf = buildMinimalPdf('BT [(Hello ) -20 (Flate PDF)] TJ ET', true);
    const emptyPdf = buildMinimalPdf('q 100 0 0 100 0 0 cm /Im0 Do Q', false);

    expect(extractPdfText(plainPdf)).toBe('Hello Plain PDF');
    expect(extractPdfText(compressedPdf)).toBe('Hello Flate PDF');
    expect(extractPdfText(emptyPdf)).toContain('no extractable text streams');

    const fetchImpl = mock<FetchLike>().mockResolvedValue(
      new Response(Buffer.from(compressedPdf), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/paper.pdf');
    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('Hello Flate PDF');
  });

  it('extracts query-matched passages from large documents and truncates with guidance', async () => {
    const largeDoc = [
      '# Overview',
      'Introductory filler '.repeat(120),
      '## SQLite FTS5 Caching',
      'Kimi uses bun:sqlite FTS5 virtual tables for sub-millisecond cached passage ranking.',
      '## Conclusion',
      'More unrelated closing text '.repeat(120),
    ].join('\n\n');

    const fetchImpl = mock<FetchLike>().mockImplementation(async () =>
      htmlResponse(largeDoc, 'text/markdown'),
    );
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const queried = await provider.fetch('https://example.com/guide.md', {
      query: 'SQLite FTS5 caching',
    });
    expect(queried.content).toContain('FTS5 virtual tables');
    expect(queried.content.length).toBeLessThan(largeDoc.length);

    const truncated = await provider.fetch('https://example.com/guide.md', { maxChars: 600 });
    expect(truncated.content).toContain('Content truncated at 600');
  });

  it('caches fetched pages with TTL expiration, bypassCache, and FTS5 passage search', async () => {
    let clock = 1000;
    const tempDir = mkdtempSync(join(tmpdir(), 'web-cache-test-'));
    const cache = new WebCache({
      dbPath: join(tempDir, 'web-cache.sqlite'),
      defaultTtlMs: 5000,
      now: () => clock,
    });
    try {
      let calls = 0;
      const fetchImpl = mock<FetchLike>().mockImplementation(async () => {
        calls += 1;
        return htmlResponse(`# Doc v${String(calls)}\n\nFast hybrid search uses RRF and BM25 ranking.`, 'text/markdown');
      });
      const provider = new LocalFetchURLProvider({ fetchImpl, cache });

      const first = await provider.fetch('https://example.com/article?utm_source=test');
      expect(first.cached).toBeUndefined();
      expect(first.content).toContain('Doc v1');

      const second = await provider.fetch('https://example.com/article');
      expect(second.cached).toBe(true);
      expect(second.content).toContain('Doc v1');
      expect(calls).toBe(1);

      const hits = cache.searchPassages('RRF BM25 ranking', 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.text).toContain('RRF');

      const bypassed = await provider.fetch('https://example.com/article', { bypassCache: true });
      expect(bypassed.content).toContain('Doc v2');
      expect(calls).toBe(2);

      clock += 10_000;
      const expired = await provider.fetch('https://example.com/article');
      expect(expired.cached).toBeUndefined();
      expect(expired.content).toContain('Doc v3');
      expect(calls).toBe(3);
      expect(cache.isSqliteBacked).toBe(true);
    } finally {
      cache.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
    const ranked = rankPassages('kv cache', [
      { url: 'https://a', title: 'A', content: '# Caching\n\nPrompt prefix KV cache hit.' },
      { url: 'https://b', title: 'B', content: '# Routing\n\nNetwork router guide.' },
    ]);
    expect(ranked[0]?.url).toBe('https://a');
  });
});
