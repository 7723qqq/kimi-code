import type { FetchLike } from '#/_base/utils/fetchLike';
import { createProxyDispatcher } from '#/_base/utils/proxy';
import { fetch as undiciFetch, type Dispatcher } from '#/_base/utils/undici-npm';

export const GITHUB_PROXY_DEFAULT_DOMAINS: readonly string[] = [
  'github.com',
  '*.github.com',
  'githubusercontent.com',
  '*.githubusercontent.com',
  'githubassets.com',
  '*.githubassets.com',
];

export interface GitHubProxySettings {
  readonly proxy?: string | undefined;
  readonly mirror?: string | undefined;
  readonly domains: readonly string[];
  readonly fallback: boolean;
}

export interface GitHubRoute {
  readonly url: string;
  readonly via: 'mirror' | 'proxy' | 'direct';
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  const target = host.trim().toLowerCase().replaceAll(/^\[|\]$/g, '');
  const rule = pattern.trim().toLowerCase();
  if (rule.length === 0) return false;
  if (rule === '*') return true;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return target.endsWith(suffix) && target.length > suffix.length;
  }
  return target === rule;
}

export function isGitHubHost(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostMatchesPattern(host, domain));
}

export function rewriteViaMirror(url: string, mirror: string): string {
  const base = mirror.trim().replace(/\/+$/, '');
  return `${base}/${url}`;
}

export function planGitHubRoute(
  url: string,
  method: string,
  settings: GitHubProxySettings,
): GitHubRoute {
  const parsed = new URL(url);
  if (!isGitHubHost(parsed.hostname, settings.domains)) return { url, via: 'direct' };
  const readable = method === 'GET' || method === 'HEAD';
  if (settings.mirror !== undefined && settings.mirror.trim().length > 0 && readable) {
    return { url: rewriteViaMirror(url, settings.mirror), via: 'mirror' };
  }
  if (settings.proxy !== undefined && settings.proxy.trim().length > 0) {
    return { url, via: 'proxy' };
  }
  return { url, via: 'direct' };
}

function dispatcherFor(proxy: string): Dispatcher | undefined {
  return createProxyDispatcher({
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1',
  });
}

export interface GitHubFetchDeps {
  readonly fetchImpl?: FetchLike;
}

type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

function undiciFetchLike(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return undiciFetch(input, init as UndiciInit) as unknown as Promise<Response>;
}

export function createGitHubFetch(
  settings: GitHubProxySettings,
  deps: GitHubFetchDeps = {},
): FetchLike {
  const passthrough = deps.fetchImpl ?? undiciFetchLike;
  let cachedProxy: string | undefined;
  let cachedDispatcher: Dispatcher | undefined;

  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = planGitHubRoute(raw, method, settings);
    if (route.via === 'direct') return passthrough(input, init);

    const attempt = (): Promise<Response> => {
      if (route.via === 'mirror') return passthrough(route.url, init);
      const proxy = settings.proxy?.trim() ?? '';
      if (cachedDispatcher === undefined || cachedProxy !== proxy) {
        cachedProxy = proxy;
        cachedDispatcher = dispatcherFor(proxy);
      }
      const dispatcher = cachedDispatcher;
      if (dispatcher === undefined) return passthrough(route.url, init);
      return undiciFetchLike(route.url, { ...init, dispatcher } as RequestInit);
    };

    try {
      return await attempt();
    } catch (error) {
      if (!settings.fallback) throw error;
      return passthrough(input, init);
    }
  };
}
