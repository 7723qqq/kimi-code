import { describe, expect, it } from 'bun:test';

import type { FetchLike } from '#/_base/utils/fetchLike';

import {
  createGitHubFetch,
  GITHUB_PROXY_DEFAULT_DOMAINS,
  hostMatchesPattern,
  isGitHubHost,
  planGitHubRoute,
  rewriteViaMirror,
  type GitHubProxySettings,
} from '#/agent/tools/github/github-proxy';

const DIRECT: GitHubProxySettings = {
  domains: GITHUB_PROXY_DEFAULT_DOMAINS,
  fallback: true,
};

type Outcome = { readonly body: string } | Error;

function recordingFetch(outcomes: Outcome[] = [{ body: 'ok' }]): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; method: string; hasDispatcher: boolean }>;
} {
  const calls: Array<{ url: string; method: string; hasDispatcher: boolean }> = [];
  let index = 0;
  const fetchImpl: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      hasDispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher !== undefined,
    });
    const next = outcomes[Math.min(index, outcomes.length - 1)] ?? { body: 'ok' };
    index += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(new Response((next as { body: string }).body) as unknown as Response);
  };
  return { fetchImpl, calls };
}

describe('hostMatchesPattern', () => {
  it('matches exact names, apex names, and subdomains', () => {
    expect(hostMatchesPattern('github.com', 'github.com')).toBe(true);
    expect(hostMatchesPattern('GitHub.com', 'GITHUB.COM')).toBe(true);
    expect(hostMatchesPattern('api.github.com', 'github.com')).toBe(false);
    expect(hostMatchesPattern('api.github.com', '*.github.com')).toBe(true);
    expect(hostMatchesPattern('github.com', '*.github.com')).toBe(false);
    expect(hostMatchesPattern('evilgithub.com', '*.github.com')).toBe(false);
    expect(hostMatchesPattern('github.com', '*')).toBe(true);
    expect(hostMatchesPattern('github.com', '')).toBe(false);
  });
});

describe('isGitHubHost', () => {
  it('recognizes the default GitHub hosts and ignores others', () => {
    expect(isGitHubHost('api.github.com', GITHUB_PROXY_DEFAULT_DOMAINS)).toBe(true);
    expect(isGitHubHost('raw.githubusercontent.com', GITHUB_PROXY_DEFAULT_DOMAINS)).toBe(true);
    expect(isGitHubHost('objects.githubusercontent.com', GITHUB_PROXY_DEFAULT_DOMAINS)).toBe(true);
    expect(isGitHubHost('example.com', GITHUB_PROXY_DEFAULT_DOMAINS)).toBe(false);
  });
});

describe('rewriteViaMirror', () => {
  it('prefixes the full url using the gh-proxy convention', () => {
    expect(rewriteViaMirror('https://raw.githubusercontent.com/a/b/main/c.ts', 'https://mirror')).toBe(
      'https://mirror/https://raw.githubusercontent.com/a/b/main/c.ts',
    );
    expect(rewriteViaMirror('https://x.test/a', 'https://mirror/')).toBe('https://mirror/https://x.test/a');
  });
});

describe('planGitHubRoute', () => {
  it('leaves non-GitHub traffic alone', () => {
    expect(planGitHubRoute('https://example.com/a', 'GET', DIRECT).via).toBe('direct');
  });

  it('mirrors readable GitHub downloads and falls back to the proxy for writes', () => {
    const settings: GitHubProxySettings = {
      ...DIRECT,
      mirror: 'https://mirror',
      proxy: 'http://127.0.0.1:9',
    };
    expect(planGitHubRoute('https://raw.githubusercontent.com/a/b/main/c', 'GET', settings)).toEqual({
      url: 'https://mirror/https://raw.githubusercontent.com/a/b/main/c',
      via: 'mirror',
    });
    expect(planGitHubRoute('https://api.github.com/repos', 'POST', settings).via).toBe('proxy');
  });

  it('routes through the proxy when no mirror is configured', () => {
    const settings: GitHubProxySettings = { ...DIRECT, proxy: 'http://127.0.0.1:9' };
    const route = planGitHubRoute('https://api.github.com/user', 'GET', settings);
    expect(route).toEqual({ url: 'https://api.github.com/user', via: 'proxy' });
  });
});

describe('createGitHubFetch', () => {
  it('passes non-GitHub requests through untouched', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const fetch = createGitHubFetch({ ...DIRECT, mirror: 'https://mirror' }, { fetchImpl });

    await fetch('https://example.com/a', { method: 'GET' });

    expect(calls).toEqual([{ url: 'https://example.com/a', method: 'GET', hasDispatcher: false }]);
  });

  it('rewrites GitHub downloads through the mirror', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const fetch = createGitHubFetch({ ...DIRECT, mirror: 'https://mirror' }, { fetchImpl });

    await fetch('https://raw.githubusercontent.com/a/b/main/c', { method: 'GET' });

    expect(calls[0]?.url).toBe('https://mirror/https://raw.githubusercontent.com/a/b/main/c');
  });

  it('never mirrors a write', async () => {
    const { fetchImpl, calls } = recordingFetch();
    const fetch = createGitHubFetch({ ...DIRECT, mirror: 'https://mirror' }, { fetchImpl });

    await fetch('https://api.github.com/repos/a/b/issues', { method: 'POST' });

    expect(calls[0]?.url).toBe('https://api.github.com/repos/a/b/issues');
    expect(calls[0]?.method).toBe('POST');
  });

  it('retries the original url directly when the accelerated route fails', async () => {
    const { fetchImpl, calls } = recordingFetch([new Error('mirror down'), { body: 'fallback' }]);
    const fetch = createGitHubFetch({ ...DIRECT, mirror: 'https://mirror' }, { fetchImpl });

    const response = await fetch('https://raw.githubusercontent.com/a/b/main/c');

    expect(await response.text()).toBe('fallback');
    expect(calls.map((call) => call.url)).toEqual([
      'https://mirror/https://raw.githubusercontent.com/a/b/main/c',
      'https://raw.githubusercontent.com/a/b/main/c',
    ]);
    expect(calls[1]?.hasDispatcher).toBe(false);
  });

  it('surfaces the failure when fallback is disabled', async () => {
    const { fetchImpl, calls } = recordingFetch([new Error('mirror down')]);
    const fetch = createGitHubFetch(
      { ...DIRECT, mirror: 'https://mirror', fallback: false },
      { fetchImpl },
    );

    let message = '';
    try {
      await fetch('https://raw.githubusercontent.com/a/b/main/c');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('mirror down');
    expect(calls).toHaveLength(1);
  });
});

describe('proxy routing over a real socket', () => {
  it('sends GitHub traffic to the configured proxy instead of connecting directly', async () => {
    const seen: string[] = [];
    const proxy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        seen.push(`${request.method} ${new URL(request.url).href}`);
        return new Response('via proxy');
      },
    });
    const port = proxy.port;
    if (port === undefined) throw new Error('proxy failed to bind');

    try {
      const fetch = createGitHubFetch({
        proxy: `http://127.0.0.1:${String(port)}`,
        domains: ['gh.test'],
        fallback: true,
      });

      const response = await fetch('http://gh.test/asset');

      expect(await response.text()).toBe('via proxy');
      expect(seen.some((line) => line.includes('gh.test/asset'))).toBe(true);
    } finally {
      await proxy.stop(true);
    }
  });

  it('keeps non-GitHub hosts on a direct connection', async () => {
    const direct = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('direct'),
    });
    const proxy = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('proxy should not see this'),
    });
    const directPort = direct.port;
    const proxyPort = proxy.port;
    if (directPort === undefined || proxyPort === undefined) throw new Error('bind failed');

    try {
      const fetch = createGitHubFetch({
        proxy: `http://127.0.0.1:${String(proxyPort)}`,
        domains: ['gh.test'],
        fallback: true,
      });

      const response = await fetch(`http://127.0.0.1:${String(directPort)}/plain`);

      expect(await response.text()).toBe('direct');
    } finally {
      await direct.stop(true);
      await proxy.stop(true);
    }
  });
});
