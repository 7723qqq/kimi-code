import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app } from 'electron';

import { log } from '../diagnostics/log';
import { setDesktopTrackImpl } from '../diagnostics/track';
import { desktopServerSecret } from './server-auth';

const READY_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 5_000;

export interface DesktopBackendProcessOptions {
  readonly webAssetsDir?: string;
  readonly extraCorsOrigins?: readonly string[];
  readonly debugEndpoints?: boolean;
  readonly browserHost?: { readonly url: string; readonly token: string };
  readonly telemetry?: {
    readonly deviceId: string;
    readonly theme: 'dark' | 'light';
    readonly launchId: string;
    readonly releaseChannel: string;
    readonly locale?: string;
    readonly firstLaunch?: boolean;
  };
}

export interface DesktopBackendProcessHandle {
  readonly origin: string;
  readonly port: number;
  readonly shutdownTelemetry: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface ReadyMessage {
  readonly type: 'ready';
  readonly origin: string;
  readonly port: number;
  readonly telemetry?: { readonly url: string; readonly token: string };
  readonly browserMcp?: { readonly url: string };
}

export function parseBackendReady(line: string): ReadyMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (fields['type'] !== 'ready') return null;
  const origin = fields['origin'];
  const port = fields['port'];
  if (typeof origin !== 'string' || typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return null;
  const browserMcpValue = fields['browserMcp'];
  const browserMcp = typeof browserMcpValue === 'object' && browserMcpValue !== null
    && typeof (browserMcpValue as Record<string, unknown>)['url'] === 'string'
    ? { url: (browserMcpValue as Record<string, string>)['url']! }
    : undefined;
  const telemetry = fields['telemetry'];
  if (
    typeof telemetry === 'object' && telemetry !== null
    && typeof (telemetry as Record<string, unknown>)['url'] === 'string'
    && typeof (telemetry as Record<string, unknown>)['token'] === 'string'
  ) {
    return {
      type: 'ready', origin, port,
      telemetry: {
        url: (telemetry as Record<string, string>)['url']!,
        token: (telemetry as Record<string, string>)['token']!,
      },
      ...(browserMcp === undefined ? {} : { browserMcp }),
    };
  }
  return { type: 'ready', origin, port, ...(browserMcp === undefined ? {} : { browserMcp }) };
}

function backendExecutable(): { command: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    const name = process.platform === 'win32' ? 'kimi-desktop-backend.exe' : 'kimi-desktop-backend';
    const command = join(process.resourcesPath, 'backend', name);
    if (!existsSync(command)) throw new Error(`Bun backend executable missing at ${command}`);
    return { command, args: [], cwd: process.resourcesPath };
  }
  const entry = join(app.getAppPath(), 'src', 'backend', 'entry.ts');
  if (!existsSync(entry)) throw new Error(`Bun backend entry missing at ${entry}`);
  return {
    command: process.env['KIMI_BUN_BINARY'] ?? 'bun',
    args: [entry],
    cwd: app.getAppPath(),
  };
}

export async function startDesktopBackendProcess(
  options: DesktopBackendProcessOptions = {},
): Promise<DesktopBackendProcessHandle> {
  const executable = backendExecutable();
  const token = desktopServerSecret();
  const child: ChildProcess = spawn(executable.command, executable.args, {
    cwd: executable.cwd,
    env: {
      ...process.env,
      KIMI_DESKTOP_TOKEN: token,
      KIMI_DESKTOP_VERSION: app.getVersion(),
      KIMI_DESKTOP_DEBUG_ENDPOINTS: options.debugEndpoints === true ? '1' : '0',
      KIMI_DESKTOP_SEARCH_WORKER: app.isPackaged
        ? join(process.resourcesPath, 'backend', 'search-worker.mjs')
        : join(app.getAppPath(), 'out', 'search-worker.mjs'),
      ...(options.webAssetsDir === undefined ? {} : { KIMI_DESKTOP_WEB_ASSETS: options.webAssetsDir }),
      ...(options.extraCorsOrigins === undefined || options.extraCorsOrigins.length === 0
        ? {}
        : { KIMI_DESKTOP_CORS_ORIGINS: options.extraCorsOrigins.join(',') }),
      ...(options.browserHost === undefined
        ? {}
        : {
            KIMI_DESKTOP_BROWSER_HOST_URL: options.browserHost.url,
            KIMI_DESKTOP_BROWSER_HOST_TOKEN: options.browserHost.token,
          }),
      ...(options.telemetry === undefined
        ? {}
        : {
            KIMI_DESKTOP_DEVICE_ID: options.telemetry.deviceId,
            KIMI_DESKTOP_THEME: options.telemetry.theme,
            KIMI_DESKTOP_LAUNCH_ID: options.telemetry.launchId,
            KIMI_DESKTOP_RELEASE_CHANNEL: options.telemetry.releaseChannel,
            ...(options.telemetry.locale === undefined ? {} : { KIMI_DESKTOP_LOCALE: options.telemetry.locale }),
            KIMI_DESKTOP_FIRST_LAUNCH: options.telemetry.firstLaunch === true ? '1' : '0',
          }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let closed = false;
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() !== '') log.warn(`[kimi-desktop-backend] ${line}`);
    }
  });

  const ready = await new Promise<ReadyMessage>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      reject(new Error(`Bun backend did not report ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== '') {
          const message = parseBackendReady(line);
          if (message !== null) {
            cleanup();
            resolve(message);
            return;
          }
          log.info(`[kimi-desktop-backend] ${line}`);
        }
        newline = buffer.indexOf('\n');
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`Bun backend exited before ready (code=${String(code)}, signal=${String(signal)})`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([
        exitPromise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, EXIT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!exited) {
        child.kill('SIGKILL');
        await exitPromise;
      }
    }
    setDesktopTrackImpl(null);
  };

  if (ready.telemetry !== undefined) {
    const target = `${ready.telemetry.url}/track`;
    const token = ready.telemetry.token;
    setDesktopTrackImpl((event, properties) => {
      void fetch(target, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, properties }),
      }).catch(() => {});
    });
  }
  console.log(`[kimi-desktop] embedded server listening on ${ready.origin}`);
  if (ready.browserMcp !== undefined) console.log(`[kimi-desktop] Browser MCP listening on ${ready.browserMcp.url}`);
  log.info(`[kimi-desktop-backend] listening on ${ready.origin}`);
  return {
    origin: ready.origin,
    port: ready.port,
    shutdownTelemetry: close,
    close,
  };
}
