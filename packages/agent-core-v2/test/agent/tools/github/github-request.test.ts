/**
 * GitHub REST transport tests (v2 port).
 *
 * Covers the transport contract ported from the v1 native Rust path: token
 * injection (explicit token > `GITHUB_TOKEN` > `GH_TOKEN`, and the
 * no-token error), query building (null/undefined dropped, scalars
 * stringified), header composition, non-2xx error normalization with the raw
 * body preserved, rate-limit header parsing, `GITHUB_API_URL` base override,
 * and network-error mapping. The network is mocked via an injectable
 * `fetchImpl`; the environment via `getEnv`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GITHUB_DEFAULT_BASE_URL,
  GITHUB_NO_TOKEN_ERROR,
  githubRequest,
} from '#/agent/tools/github/github-request';

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('githubRequest', () => {
  it('resolves the token from GITHUB_TOKEN and sends it as a bearer header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_env_token' : undefined;

    const res = await githubRequest('GET', '/user', {}, { fetchImpl, getEnv });

    expect(res).toEqual({ status: 200, ok: true, body: '{"id":1}', rateRemaining: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITHUB_DEFAULT_BASE_URL}/user`);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer ghp_env_token',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kimi-code',
    });
  });

  it('prefers the explicit token over the environment', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_env_token' : undefined;

    await githubRequest('GET', '/user', { token: 'ghp_config_token' }, { fetchImpl, getEnv });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ghp_config_token' });
  });

  it('falls back from GITHUB_TOKEN to GH_TOKEN', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const getEnv = (name: string): string | undefined =>
      name === 'GH_TOKEN' ? 'ghp_gh_token' : undefined;

    await githubRequest('GET', '/user', {}, { fetchImpl, getEnv });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ghp_gh_token' });
  });

  it('returns the no-token error without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const getEnv = (): undefined => undefined;

    const res = await githubRequest('GET', '/user', {}, { fetchImpl, getEnv });

    expect(res).toEqual({ status: 0, ok: false, body: '', error: GITHUB_NO_TOKEN_ERROR });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats an empty explicit token as unset and falls back to the env', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const getEnv = (name: string): string | undefined =>
      name === 'GH_TOKEN' ? 'ghp_gh_token' : undefined;

    await githubRequest('GET', '/user', { token: '' }, { fetchImpl, getEnv });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ghp_gh_token' });
  });

  it('builds the query string from scalars and drops null/undefined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_token' : undefined;

    await githubRequest(
      'GET',
      '/repos/o/r/issues',
      { query: { state: 'open', per_page: 100, draft: true, skip: null, absent: undefined } },
      { fetchImpl, getEnv },
    );

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITHUB_DEFAULT_BASE_URL}/repos/o/r/issues?state=open&per_page=100&draft=true`);
  });

  it('serializes a JSON body with the content-type header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_token' : undefined;

    await githubRequest(
      'POST',
      '/repos/o/r/issues',
      { body: { title: 'hi', draft: false } },
      { fetchImpl, getEnv },
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"title":"hi","draft":false}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('normalizes non-2xx responses to GitHub API error with the raw body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ message: 'Not Found' }, 404, { 'x-ratelimit-remaining': '4998' }),
    );
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_token' : undefined;

    const res = await githubRequest('GET', '/repos/o/r', {}, { fetchImpl, getEnv });

    expect(res).toEqual({
      status: 404,
      ok: false,
      body: '{"message":"Not Found"}',
      error: 'GitHub API error 404',
      rateRemaining: 4998,
    });
  });

  it('parses the rate-limit header on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ full_name: 'o/r' }, 200, { 'x-ratelimit-remaining': '1234' }),
    );
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_token' : undefined;

    const res = await githubRequest('GET', '/repos/o/r', {}, { fetchImpl, getEnv });

    expect(res.rateRemaining).toBe(1234);
  });

  it('maps transport failures to network errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_token' : undefined;

    const res = await githubRequest('GET', '/user', {}, { fetchImpl, getEnv });

    expect(res).toEqual({ status: 0, ok: false, body: '', error: 'network error: ECONNREFUSED' });
  });

  it('honors GITHUB_API_URL as the base', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const getEnv = (name: string): string | undefined => {
      if (name === 'GITHUB_API_URL') return 'https://github.example.com/api/v3';
      if (name === 'GITHUB_TOKEN') return 'ghp_token';
      return undefined;
    };

    await githubRequest('GET', '/user', {}, { fetchImpl, getEnv });

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://github.example.com/api/v3/user');
  });

  it('re-throws when the caller signal is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const getEnv = (name: string): string | undefined =>
      name === 'GITHUB_TOKEN' ? 'ghp_token' : undefined;
    controller.abort();

    await expect(
      githubRequest('GET', '/user', {}, { fetchImpl, getEnv, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
