const ORIGIN_STATE = new Map<string, 'unknown' | 'ok' | 'dead'>();
const PROBING = new Set<string>();

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
  }
}
