export type Env = Readonly<Record<string, string | undefined>>;

export interface SocksProxyConfig {
  readonly type: 4 | 5;
  readonly host: string;
  readonly port: number;
  readonly userId?: string;
  readonly password?: string;
}

const SOCKS_SCHEMES = new Set(['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']);

function schemeOf(value: string): string | undefined {
  return /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
}

function firstNonBlank(env: Env, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function httpSchemeValue(value: string | undefined): string | undefined {
  return value !== undefined && !SOCKS_SCHEMES.has(schemeOf(value) ?? '') ? value : undefined;
}

export function hasHttpProxy(env: Env): boolean {
  return [
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
  ].some((value) => httpSchemeValue(value) !== undefined);
}

export function resolveHttpProxyUrls(env: Env): { httpProxy?: string; httpsProxy?: string } {
  const allProxy = httpSchemeValue(firstNonBlank(env, ['all_proxy', 'ALL_PROXY']));
  return {
    httpProxy: httpSchemeValue(firstNonBlank(env, ['http_proxy', 'HTTP_PROXY'])) ?? allProxy,
    httpsProxy: httpSchemeValue(firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY'])) ?? allProxy,
  };
}

export function resolveSocksProxy(env: Env): SocksProxyConfig | undefined {
  const candidates = [
    firstNonBlank(env, ['all_proxy', 'ALL_PROXY']),
    firstNonBlank(env, ['https_proxy', 'HTTPS_PROXY']),
    firstNonBlank(env, ['http_proxy', 'HTTP_PROXY']),
  ];
  for (const value of candidates) {
    if (value === undefined) continue;
    const scheme = schemeOf(value);
    if (scheme === undefined || !SOCKS_SCHEMES.has(scheme)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    const config: SocksProxyConfig = {
      type: scheme === 'socks4' || scheme === 'socks4a' ? 4 : 5,
      host: url.hostname.replaceAll(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : 1080,
      ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    };
    return config;
  }
  return undefined;
}

export function isProxyConfigured(env: Env): boolean {
  return hasHttpProxy(env) || resolveSocksProxy(env) !== undefined;
}
