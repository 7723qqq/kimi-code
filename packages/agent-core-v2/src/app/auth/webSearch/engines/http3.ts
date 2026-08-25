import { isProxyConfigured } from '#/_base/utils/proxy';

const ORIGIN_STATE = new Map<string, 'unknown' | 'ok' | 'dead'>();
const PROBING = new Set<string>();

interface CapturedNoProxy {
  NO_PROXY: string | undefined;
  no_proxy: string | undefined;
}

const PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'] as const;

const DIRECT_HOSTS = new Set<string>();
let capturedNoProxy: CapturedNoProxy | undefined;

function renderNoProxy(captured: CapturedNoProxy): string {
  const parts = new Set<string>();
  for (const raw of [captured.NO_PROXY, captured.no_proxy]) {
    for (const piece of raw?.split(',') ?? []) {
      const trimmed = piece.trim();
      if (trimmed !== '') parts.add(trimmed);
    }
  }
  for (const host of DIRECT_HOSTS) parts.add(host);
  return [...parts].join(',');
}

function pushDirectHost(host: string): void {
  capturedNoProxy ??= {
    NO_PROXY: process.env['NO_PROXY'],
    no_proxy: process.env['no_proxy'],
  };
  DIRECT_HOSTS.add(host);
  const value = renderNoProxy(capturedNoProxy);
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = value;
  }
}

function popDirectHost(host: string): void {
  const captured = capturedNoProxy;
  if (captured === undefined) return;
  DIRECT_HOSTS.delete(host);
  if (DIRECT_HOSTS.size > 0) {
    const value = renderNoProxy(captured);
    for (const key of PROXY_ENV_KEYS) {
      process.env[key] = value;
    }
    return;
  }
  for (const key of PROXY_ENV_KEYS) {
    const original = captured[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

export type H3OriginState = 'unknown' | 'ok' | 'dead';

export function h3OriginState(origin: string): H3OriginState {
  return ORIGIN_STATE.get(origin) ?? 'unknown';
}

export function markH3Origin(origin: string, state: 'ok' | 'dead'): void {
  ORIGIN_STATE.set(origin, state);
}

export function resetH3States(): void {
  ORIGIN_STATE.clear();
  PROBING.clear();
  DIRECT_HOSTS.clear();
  capturedNoProxy = undefined;
}

export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

export function h3Disabled(env: Record<string, string | undefined>): boolean {
  return env['KIMI_CODE_SEARCH_H3'] === '0';
}

/**
 * Register a one-shot background probe for an origin whose H3 support is
 * still unknown. The attempt callback should perform a cheap request over
 * HTTP/3 and resolve true when it succeeded. Probes are deduplicated per
 * origin while in flight and never throw.
 */
export function scheduleH3Probe(origin: string, attempt: () => Promise<boolean>): void {
  if (!isBunRuntime()) return;
  if ((process.env['KIMI_CODE_SEARCH_H3'] ?? '') === '0') return;
  if (h3OriginState(origin) !== 'unknown') return;
  if (PROBING.has(origin)) return;
  PROBING.add(origin);
  void attempt()
    .then((ok) => markH3Origin(origin, ok ? 'ok' : 'dead'))
    .catch(() => markH3Origin(origin, 'dead'))
    .finally(() => {
      PROBING.delete(origin);
    });
}

export interface H3FetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Issue a request over HTTP/3 through the Bun runtime. Throws whenever the
 * origin does not complete a QUIC handshake or the request fails for any
 * other reason — callers are expected to fall back to the regular stack.
 *
 * The request always leaves directly: when a proxy is configured for the
 * process, the target host is exempted via `NO_PROXY` for the duration of
 * this call so the runtime's forced-h3 path does not refuse it, letting an
 * OS-level tunnel capture the UDP traffic while everything else keeps
 * riding the proxy.
 */
export async function h3Fetch(
  url: string,
  init: H3FetchInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  const signals = init.signal
    ? [controller.signal, init.signal]
    : [controller.signal];
  let routedDirectly = false;
  if (isProxyConfigured(process.env)) {
    pushDirectHost(new URL(url).hostname.toLowerCase());
    routedDirectly = true;
  }
  try {
    const requestInit = {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.any(signals),
      protocol: 'http3',
    } as RequestInit;
    return await fetch(url, requestInit);
  } finally {
    clearTimeout(timer);
    if (routedDirectly) popDirectHost(new URL(url).hostname.toLowerCase());
  }
}
