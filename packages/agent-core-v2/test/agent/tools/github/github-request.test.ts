import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_DEFAULT_BASE_URL,
  GITHUB_NO_TOKEN_ERROR,
  githubRequest,
} from '#/agent/tools/github/github-request';

const TOKEN = 'ghp_token';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('githubRequest', () => {
  it('sends the caller-supplied token as a bearer header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 1 }));

    const res = await githubRequest('GET', '/user', { token: TOKEN }, { fetchImpl });

    expect(res).toEqual({ status: 200, ok: true, body: '{"id":1}', rateRemaining: undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITHUB_DEFAULT_BASE_URL}/user`);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kimi-code',
    });
  });

  it('never reads the environment for credentials', async () => {
    const fetchImpl = vi.fn();
    vi.stubEnv('GITHUB_TOKEN', 'ghp_from_env');
    vi.stubEnv('GH_TOKEN', 'ghp_from_env_alt');

    const res = await githubRequest('GET', '/user', {}, { fetchImpl });

    expect(res).toEqual({ status: 0, ok: false, body: '', error: GITHUB_NO_TOKEN_ERROR });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never reads the environment for the base URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubEnv('GITHUB_API_URL', 'https://from-env.example.com/api/v3');

    await githubRequest('GET', '/user', { token: TOKEN }, { fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${GITHUB_DEFAULT_BASE_URL}/user`);
  });

  it('returns the no-token error without calling fetch', async () => {
    const fetchImpl = vi.fn();

    const res = await githubRequest('GET', '/user', {}, { fetchImpl });

    expect(res).toEqual({ status: 0, ok: false, body: '', error: GITHUB_NO_TOKEN_ERROR });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names both the config section and the env vars in the no-token error', () => {
    expect(GITHUB_NO_TOKEN_ERROR).toContain('[github]');
    expect(GITHUB_NO_TOKEN_ERROR).toContain('GITHUB_TOKEN');
    expect(GITHUB_NO_TOKEN_ERROR).toContain('GH_TOKEN');
  });

  it('treats an empty token as unset', async () => {
    const fetchImpl = vi.fn();

    const res = await githubRequest('GET', '/user', { token: '' }, { fetchImpl });

    expect(res.error).toBe(GITHUB_NO_TOKEN_ERROR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honors an explicit base URL and trims its trailing slash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));

    await githubRequest(
      'GET',
      '/user',
      { token: TOKEN, baseUrl: 'https://ghe.example.com/api/v3/' },
      { fetchImpl },
    );

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ghe.example.com/api/v3/user');
  });

  it('builds the query string from scalars and drops null/undefined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    await githubRequest(
      'GET',
      '/repos/o/r/issues',
      {
        token: TOKEN,
        query: { state: 'open', per_page: 100, draft: true, skip: null, absent: undefined },
      },
      { fetchImpl },
    );

    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${GITHUB_DEFAULT_BASE_URL}/repos/o/r/issues?state=open&per_page=100&draft=true`,
    );
  });

  it('serializes a JSON body with the content-type header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));

    await githubRequest(
      'POST',
      '/repos/o/r/issues',
      { token: TOKEN, body: { title: 'hi', draft: false } },
      { fetchImpl },
    );

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"title":"hi","draft":false}');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('normalizes non-2xx responses to GitHub API error with the raw body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ message: 'Not Found' }, 404, { 'x-ratelimit-remaining': '4998' }),
      );

    const res = await githubRequest('GET', '/repos/o/r', { token: TOKEN }, { fetchImpl });

    expect(res).toEqual({
      status: 404,
      ok: false,
      body: '{"message":"Not Found"}',
      error: 'GitHub API error 404',
      rateRemaining: 4998,
    });
  });

  it('parses the rate-limit header on success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ full_name: 'o/r' }, 200, { 'x-ratelimit-remaining': '1234' }),
      );

    const res = await githubRequest('GET', '/repos/o/r', { token: TOKEN }, { fetchImpl });

    expect(res.rateRemaining).toBe(1234);
  });

  it('maps transport failures to network errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await githubRequest('GET', '/user', { token: TOKEN }, { fetchImpl });

    expect(res).toEqual({ status: 0, ok: false, body: '', error: 'network error: ECONNREFUSED' });
  });

  it('re-throws when the caller signal is aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    controller.abort();

    await expect(
      githubRequest('GET', '/user', { token: TOKEN }, { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
