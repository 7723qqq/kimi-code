import { randomBytes, timingSafeEqual } from 'node:crypto';

import { startServer, type RunningServer, type ServerHostIdentity } from '@moonshot-ai/kap-server';
import { createDesktopAuthTokenService } from './auth';
import { installGlobalProxyDispatcher, resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { startDesktopBrowserMcp } from './browser/browser-mcp';
import { createDesktopBrowserAccess, registerDesktopBrowserMcp } from './browser/browser-mcp-registration';
import { registerDesktopBrowserDialogReminder } from './browser/browser-dialog-reminder';
import type { DesktopBrowserHostClient } from './browser/host-client';
import { localFileAddressUrl } from '../shared/browser-local-file';
import { startTelemetryInbox, type TelemetryInbox } from './diagnostics/inbox';
import { wireDesktopTelemetry, type DesktopTelemetryIdentity } from './diagnostics/telemetry';

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
  readonly browserHost?: DesktopBrowserHostClient;
  readonly telemetry?: DesktopTelemetryIdentity;
  readonly env?: Record<string, string | undefined>;
}

export interface DesktopBackend {
  readonly origin: string;
  readonly port: number;
  readonly token: string;
  readonly telemetry?: { readonly url: string; readonly token: string };
  readonly browserMcp?: { readonly url: string };
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
  const auth = options.authTokenService
    ?? (options.token === undefined ? tokenService(token) : createDesktopAuthTokenService(options.homeDir ?? resolveKimiHome(), options.token));
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
    env: options.env ?? { ...process.env },
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
  let browserMcp: Awaited<ReturnType<typeof startDesktopBrowserMcp>> | undefined;
  let browserRegistration: ReturnType<typeof registerDesktopBrowserMcp> | undefined;
  let dialogReminder: ReturnType<typeof registerDesktopBrowserDialogReminder> | undefined;
  const telemetry = options.telemetry === undefined ? null : await wireDesktopTelemetry(server.core, options.telemetry);
  const inbox: TelemetryInbox | undefined = telemetry === null ? undefined : await startTelemetryInbox();
  let closePromise: Promise<void> | undefined;
  const closeImpl = async (): Promise<void> => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => browserRegistration?.dispose()),
      Promise.resolve().then(() => dialogReminder?.dispose()),
      Promise.resolve().then(() => telemetry?.shutdown()),
      Promise.resolve().then(() => inbox?.close()),
      Promise.resolve().then(() => browserMcp?.close()),
      Promise.resolve().then(() => server.close()),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Server cleanup failed');
  };
  const close = (): Promise<void> => (closePromise ??= closeImpl());
  try {
    const host = options.browserHost;
    if (host !== undefined) {
      await host.refresh();
      const access = createDesktopBrowserAccess(host.agentControl, host.subagentControl);
      browserMcp = await startDesktopBrowserMcp({
        access,
        host,
        localFileAddress: (url) => host.localFilesEnabled() && localFileAddressUrl(url) !== null,
      });
      browserRegistration = registerDesktopBrowserMcp(server.core, browserMcp.config, access, host);
      dialogReminder = registerDesktopBrowserDialogReminder(server.core, {
        collect: (sessionId) => host.collectDialogs(sessionId),
        forgetSession: (sessionId) => host.forgetSession(sessionId),
      });
    }
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    origin: `http://${server.host}:${server.port}`,
    port: server.port,
    token: auth.getToken(),
    ...(inbox === undefined ? {} : { telemetry: { url: inbox.url, token: inbox.token } }),
    ...(browserMcp === undefined ? {} : { browserMcp: { url: browserMcp.url } }),
    close,
  };
}
