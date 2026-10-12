/**
 * Tests for the session-creation REST client (`POST {baseUrl}/api/v1/sessions`).
 *
 * The bug this pins down: the sidebar used to `await res.json()` before the
 * `code !== 0` branch and discarded the promise (`void onCreate(ws)`), so a
 * daemon answering 401/502 with an HTML page made "+ New session" fail with no
 * session, no alert and no feedback — only an unhandled rejection in devtools.
 * Every failure mode must therefore come back as `{ ok: false, reason }`.
 */

import { describe, expect, it } from 'vitest';

import { createSession } from '../src/lib/createSession';

/** A fetch stub whose `json()` either yields `body` or rejects like a text/html page. */
function fakeFetch(status: number, body: unknown | (() => never)) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'ERR',
      json: async () => {
        if (typeof body === 'function') body();
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function okBody(data: unknown) {
  return { code: 0, msg: 'success', data, request_id: 'req-1' };
}

function errBody(code: number, msg: string) {
  return { code, msg, data: null, request_id: 'req-1' };
}

/** Collects rejections nobody observed while `run` executes. */
async function withUnhandledRejectionProbe(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await run();
    // Two macrotask turns, so an orphaned rejection has time to surface.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  return seen;
}

describe('createSession', () => {
  it('reports a non-2xx text/html answer as HTTP <status> without an unhandled rejection', async () => {
    // 401 from the global auth hook: an HTML page, so `res.json()` throws.
    const { fetchImpl } = fakeFetch(401, () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0');
    });

    let result: Awaited<ReturnType<typeof createSession>> | undefined;
    const unhandled = await withUnhandledRejectionProbe(async () => {
      // Mirrors the sidebar caller: the returned promise is the only observer.
      result = await createSession({ baseUrl: 'http://h:1', fetchImpl });
    });

    expect(result).toEqual({ ok: false, reason: 'HTTP 401' });
    expect(unhandled).toEqual([]);
  });

  it('reports a 200 with a non-JSON body as a failure instead of throwing', async () => {
    const { fetchImpl } = fakeFetch(200, () => {
      throw new SyntaxError('Unexpected end of JSON input');
    });

    await expect(createSession({ baseUrl: 'http://h:1', fetchImpl })).resolves.toEqual({
      ok: false,
      reason: 'HTTP 200 (non-JSON body)',
    });
  });

  it('turns a non-zero business code into ok:false carrying the server message', async () => {
    const { fetchImpl } = fakeFetch(200, errBody(40001, 'invalid params'));

    await expect(createSession({ baseUrl: 'http://h:1', fetchImpl })).resolves.toEqual({
      ok: false,
      reason: 'invalid params',
    });
  });

  it('returns the session id on a code:0 envelope', async () => {
    const { fetchImpl } = fakeFetch(200, okBody({ id: 's1' }));

    await expect(createSession({ baseUrl: 'http://h:1', fetchImpl })).resolves.toEqual({
      ok: true,
      sessionId: 's1',
    });
  });

  it('posts the workspace id, or the prompted cwd plus the bearer token', async () => {
    const withWorkspace = fakeFetch(200, okBody({ id: 's1' }));
    await createSession({
      baseUrl: 'http://h:1',
      token: 'tok',
      workspaceId: 'ws1',
      fetchImpl: withWorkspace.fetchImpl,
    });
    expect(withWorkspace.calls[0]!.url).toBe('http://h:1/api/v1/sessions');
    expect(withWorkspace.calls[0]!.init?.method).toBe('POST');
    expect(withWorkspace.calls[0]!.init?.body).toBe(JSON.stringify({ workspace_id: 'ws1' }));
    expect(withWorkspace.calls[0]!.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
    });

    const withCwd = fakeFetch(200, okBody({ id: 's2' }));
    await createSession({ baseUrl: 'http://h:1', cwd: '/tmp/proj', fetchImpl: withCwd.fetchImpl });
    expect(withCwd.calls[0]!.init?.body).toBe(
      JSON.stringify({ metadata: { cwd: '/tmp/proj' } }),
    );
    expect(withCwd.calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('reports a missing data.id rather than returning an undefined session', async () => {
    const { fetchImpl } = fakeFetch(200, okBody({}));

    await expect(createSession({ baseUrl: 'http://h:1', fetchImpl })).resolves.toEqual({
      ok: false,
      reason: 'HTTP 200 (no data.id)',
    });
  });
});
