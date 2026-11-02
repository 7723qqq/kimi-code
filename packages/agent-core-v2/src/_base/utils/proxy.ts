import { SocksClient } from 'socks';

import {
  Agent,
  buildConnector,
  type Dispatcher,
  EnvHttpProxyAgent,
  setGlobalDispatcher as undiciSetGlobalDispatcher,
} from '#/_base/utils/undici-npm';

import {
  hasHttpProxy,
  isProxyConfigured,
  resolveHttpProxyUrls,
  resolveSocksProxy,
  type Env,
  type SocksProxyConfig,
} from './proxyEnv';

export type { Env, SocksProxyConfig } from './proxyEnv';
export { isProxyConfigured, resolveSocksProxy } from './proxyEnv';

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]'] as const;


export function resolveNoProxy(env: Env): string {
  const raw =
    [env['no_proxy'], env['NO_PROXY']].find((value) => (value?.trim() ?? '').length > 0) ?? '';
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.includes('*')) return '*';
  for (const loopback of LOOPBACK_NO_PROXY) {
    if (!hosts.includes(loopback)) hosts.push(loopback);
  }
  return hosts.join(',');
}

export function makeNoProxyMatcher(
  noProxy: string,
): (host: string, port?: number | string) => boolean {
  const entries = noProxy
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (entries.includes('*')) return () => true;
  const parsed = entries.map(parseNoProxyEntry);
  return (host: string, port?: number | string) => {
    const target = host.toLowerCase().replaceAll(/^\[|\]$/g, '');
    const targetPort = port === undefined ? undefined : String(port);
    return parsed.some(
      ({ host: entry, port: entryPort }) =>
        (entryPort === undefined || entryPort === targetPort) &&
        (target === entry || target.endsWith(`.${entry}`)),
    );
  };
}

function parseNoProxyEntry(entry: string): { host: string; port?: string } {
  let host = entry;
  let port: string | undefined;
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    host = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest.startsWith(':')) port = rest.slice(1);
  } else {
    const colon = entry.indexOf(':');
    if (colon !== -1 && colon === entry.lastIndexOf(':') && /^\d+$/.test(entry.slice(colon + 1))) {
      host = entry.slice(0, colon);
      port = entry.slice(colon + 1);
    }
  }
  if (host.startsWith('*.')) host = host.slice(2);
  else if (host.startsWith('.')) host = host.slice(1);
  return port === undefined ? { host } : { host, port };
}

export interface ProxyAgentFactories {
  readonly makeHttpAgent: (options: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy: string;
  }) => Dispatcher;
  readonly makeSocksAgent: (options: { proxy: SocksProxyConfig; noProxy: string }) => Dispatcher;
}

const defaultMakeHttpAgent: ProxyAgentFactories['makeHttpAgent'] = ({
  httpProxy,
  httpsProxy,
  noProxy,
}) => new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });

const defaultMakeSocksAgent: ProxyAgentFactories['makeSocksAgent'] = ({ proxy, noProxy }) => {
  const directConnect = buildConnector({});
  const bypass = makeNoProxyMatcher(noProxy);
  const connect: typeof directConnect = (options, callback) => {
    if (bypass(options.hostname, options.port)) {
      directConnect(options, callback);
      return;
    }
    void (async () => {
      try {
        const isTls = options.protocol === 'https:';
        const port = Number(options.port) || (isTls ? 443 : 80);
        const { socket } = await SocksClient.createConnection({
          proxy: {
            host: proxy.host,
            port: proxy.port,
            type: proxy.type,
            userId: proxy.userId,
            password: proxy.password,
          },
          command: 'connect',
          destination: { host: options.hostname, port },
        });
        if (isTls) {
          directConnect(
            { ...options, httpSocket: socket } as Parameters<typeof directConnect>[0],
            callback,
          );
        } else {
          socket.setNoDelay(true);
          callback(null, socket);
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)), null);
      }
    })();
  };
  return new Agent({ connect });
};

export function createProxyDispatcher(
  env: Env,
  factories: Partial<ProxyAgentFactories> = {},
): Dispatcher | undefined {
  const { makeHttpAgent = defaultMakeHttpAgent, makeSocksAgent = defaultMakeSocksAgent } =
    factories;
  try {
    if (hasHttpProxy(env)) {
      const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
      return makeHttpAgent({
        httpProxy: httpProxy ?? '',
        httpsProxy: httpsProxy ?? '',
        noProxy: resolveNoProxy(env),
      });
    }
    const socks = resolveSocksProxy(env);
    if (socks !== undefined) {
      return makeSocksAgent({ proxy: socks, noProxy: resolveNoProxy(env) });
    }
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `kimi: ignoring invalid proxy configuration (${reason}); connecting directly\n`,
    );
    return undefined;
  }
}

export interface InstallProxyDeps {
  readonly setGlobalDispatcher: (dispatcher: Dispatcher) => void;
  readonly createProxyDispatcher: (env: Env) => Dispatcher | undefined;
}

const defaultInstallProxyDeps: InstallProxyDeps = {
  setGlobalDispatcher: undiciSetGlobalDispatcher,
  createProxyDispatcher,
};

export function installGlobalProxyDispatcher(
  env: Env,
  deps: InstallProxyDeps = defaultInstallProxyDeps,
): boolean {
  const dispatcher = deps.createProxyDispatcher(env);
  if (dispatcher === undefined) return false;
  deps.setGlobalDispatcher(dispatcher);
  return true;
}

export function proxyEnvForChild(env: Env): Record<string, string> {
  if (!hasHttpProxy(env)) return {};
  const noProxy = resolveNoProxy(env);
  const result: Record<string, string> = {
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  const { httpProxy, httpsProxy } = resolveHttpProxyUrls(env);
  if (httpProxy !== undefined) {
    result['HTTP_PROXY'] = httpProxy;
    result['http_proxy'] = httpProxy;
  }
  if (httpsProxy !== undefined) {
    result['HTTPS_PROXY'] = httpsProxy;
    result['https_proxy'] = httpsProxy;
  }
  return result;
}

export function reconcileChildNoProxy(
  childEnv: Record<string, string>,
  configEnv?: Record<string, string>,
): void {
  const override = [configEnv?.['no_proxy'], configEnv?.['NO_PROXY']].find(
    (value) => (value?.trim() ?? '').length > 0,
  );
  if (override === undefined) return;
  const noProxy = resolveNoProxy({ no_proxy: override, NO_PROXY: override });
  childEnv['NO_PROXY'] = noProxy;
  childEnv['no_proxy'] = noProxy;
}