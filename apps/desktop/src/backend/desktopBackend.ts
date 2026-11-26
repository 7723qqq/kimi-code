import { randomBytes, timingSafeEqual } from 'node:crypto';

import { startServer, type RunningServer, type ServerHostIdentity } from '@moonshot-ai/kap-server';
import { installGlobalProxyDispatcher, resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

export interface DesktopBackendAuth {
  readonly _serviceBrand: undefined;
  getToken(): string;
  isValid(candidate: string): Promise<boolean>;
}

export interface DesktopBackendOptions {
  readonly homeDir?: string;
  readonly webAssetsDir?: string;
  readonly corsOrigins?: readonly string[];
  readonly debugEndpoints?: boolean;
  readonly serverVersion?: string;
  readonly identity?: ServerHostIdentity;
  readonly token?: string;
  readonly authTokenService?: DesktopBackendAuth;
  readonly disableAuth?: boolean;
  readonly logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

export interface DesktopBackend {
  readonly origin: string;
  readonly port: number;
  readonly token: string;
  close(): Promise<void>;
}

function tokenService(token: string): DesktopBackendAuth {
  return {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: (candidate) => Promise.resolve(candidate === token),
  };
}

export function createDesktopBackendAuth(token: string): DesktopBackendAuth {
  return {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: (candidate) => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(token);
      return Promise.resolve(a.length === b.length && timingSafeEqual(a, b));
    },
  };
}

export async function startDesktopBackend(options: DesktopBackendOptions = {}): Promise<DesktopBackend> {
  installGlobalProxyDispatcher();
  const token = options.token ?? randomBytes(32).toString('base64url');
  const auth = options.authTokenService ?? tokenService(token);
  const identity = options.identity ?? {
    productName: 'kimi-code-desktop',
    version: options.serverVersion ?? '0.0.0',
    platform: `desktop-${process.platform}`,
  };
  const server: RunningServer = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir: options.homeDir ?? resolveKimiHome(),
    webAssetsDir: options.webAssetsDir,
    serverVersion: options.serverVersion,
    logLevel: options.logLevel ?? 'silent',
    hostIdentity: {
      ...identity,
      displayName: identity.displayName ?? 'Kimi Code Desktop',
    },
    corsOrigins: ['app://renderer', ...(options.corsOrigins ?? [])],
    authTokenService: auth,
    disableAuth: options.disableAuth,
    debugEndpoints: options.debugEndpoints,
  });
  return {
    origin: `http://${server.host}:${server.port}`,
    port: server.port,
    token: auth.getToken(),
    close: () => server.close(),
  };
}
