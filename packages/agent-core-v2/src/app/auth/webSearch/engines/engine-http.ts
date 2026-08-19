/**
 * `auth` domain (cross-cutting) — undici-based request shim for the ported
 * search engines (replaces open-websearch's axios layer).
 *
 * Honours the standard proxy environment variables (`HTTP_PROXY` /
 * `HTTPS_PROXY` / `NO_PROXY`) through kimi's shared proxy helpers, applies a
 * per-request timeout, and returns the response body as text. All search
 * endpoints are public, so no SSRF pinning is applied here (the
 * `LocalFetchURLProvider` keeps that for user-supplied URLs).
 */

import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from 'undici';

import { isProxyConfigured, makeNoProxyMatcher, resolveNoProxy } from '#/_base/utils/proxy';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface EngineRequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  body?: string;
  /** Caller-supplied abort signal, combined with the internal timeout. */
  signal?: AbortSignal;
  /** Do not follow redirects (the caller inspects the Location header). */
  manualRedirect?: boolean;
}

export interface EngineHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array> | null;
  header(name: string): string | null;
}

let dispatcherCache: Dispatcher | undefined;

function dispatcherFor(url: string): Dispatcher | undefined {
  if (!isProxyConfigured(process.env)) return undefined;
  const proxyUrl =
    process.env['HTTPS_PROXY'] ??
    process.env['https_proxy'] ??
    process.env['HTTP_PROXY'] ??
    process.env['http_proxy'];
  if (proxyUrl === undefined || proxyUrl === '') return undefined;
  const noProxy = makeNoProxyMatcher(resolveNoProxy(process.env));
  const parsed = new URL(url);
  const port = parsed.port !== '' ? parsed.port : parsed.protocol === 'https:' ? '443' : '80';
  if (noProxy(parsed.hostname, port)) return undefined;
  dispatcherCache ??= new ProxyAgent(proxyUrl) as unknown as Dispatcher;
  return dispatcherCache;
}

export async function engineFetch(
  url: string,
  options: EngineRequestOptions = {},
): Promise<EngineHttpResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const dispatcher = dispatcherFor(url);
  // POST / body requests previously dropped the signal entirely; they now get
  // the same timeout, and any caller-provided signal is combined with it.
  const signal =
    options.signal !== undefined
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
  try {
    const response = await undiciFetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...options.headers,
      },
      body: options.body,
      redirect: options.manualRedirect === true ? 'manual' : 'follow',
      signal,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text: () => response.text(),
      stream: () => response.body as ReadableStream<Uint8Array> | null,
      header: (name: string) => response.headers.get(name),
    };
  } finally {
    clearTimeout(timer);
  }
}

export { DEFAULT_USER_AGENT };
