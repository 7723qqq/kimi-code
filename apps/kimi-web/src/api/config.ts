// apps/kimi-web/src/api/config.ts
// Reads Vite env, builds REST/WS URLs, manages stable clientId.

const CLIENT_ID_KEY = 'kimi-web.client-id';

export interface KimiApiConfig {
  daemonHttpUrl: string;
  clientId: string;
}

export function readKimiApiConfig(): KimiApiConfig {
  return {
    daemonHttpUrl: normalizeDaemonOrigin(import.meta.env.VITE_KIMI_DAEMON_HTTP_URL),
    clientId: getClientId(),
  };
}

// Default to SAME-ORIGIN so we never depend on CORS:
//  - dev: the SPA is served by Vite; the Vite dev proxy forwards /v1, /healthz
//    and /v1/ws to the daemon (see vite.config.ts), so the browser only ever
//    talks to its own origin.
//  - prod: `kimi web` serves this built SPA from the daemon itself, so the
//    daemon's origin already is the API origin.
// Set VITE_KIMI_DAEMON_HTTP_URL to connect directly to an absolute daemon
// origin instead (that path does require the daemon to send CORS headers).
function defaultDaemonOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://127.0.0.1:7878';
}

export function normalizeDaemonOrigin(value: string | undefined): string {
  const raw = value && value.trim() ? value : defaultDaemonOrigin();
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

// The real daemon serves everything (incl. healthz + ws) under the /api/v1 prefix.
export function buildRestUrl(origin: string, path: string): string {
  return `${origin}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
}

export function buildWsUrl(origin: string, clientId: string): string {
  const url = new URL(`${origin}/api/v1/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client_id', clientId);
  return url.toString();
}

function getClientId(): string {
  const stored = globalThis.localStorage?.getItem(CLIENT_ID_KEY);
  if (stored) return stored;
  const generated = `web_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  globalThis.localStorage?.setItem(CLIENT_ID_KEY, generated);
  return generated;
}
