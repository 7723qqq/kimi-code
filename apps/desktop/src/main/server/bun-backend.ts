import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { BackendChannel } from '../../shared/backend-channel';
import {
  BackendRequestError,
  type BackendInput,
  type BackendOutput,
} from '../../shared/backend-protocol';

export interface BackendLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function resolveBackendLaunch(options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  bunPath?: string;
  platform?: NodeJS.Platform;
}): BackendLaunch {
  const platform = options.platform ?? process.platform;
  if (options.packaged) {
    const command = join(
      options.resourcesPath,
      'bun-backend',
      `kimi-desktop-backend${platform === 'win32' ? '.exe' : ''}`,
    );
    if (!isAbsolute(command) || !statSync(command).isFile())
      throw new Error('Packaged Desktop Bun backend is missing');
    return { command, args: [], cwd: options.resourcesPath };
  }
  const command = options.bunPath;
  if (command === undefined || !isAbsolute(command) || !statSync(command).isFile()) {
    throw new Error(
      'Desktop development requires an explicit Bun executable; launch with bun run dev or bun run start',
    );
  }
  return {
    command,
    args: [
      '--no-env-file',
      '--preload',
      join(options.appPath, 'scripts', 'backend-preload.ts'),
      join(options.appPath, 'src', 'backend', 'launcher.ts'),
    ],
    cwd: options.appPath,
  };
}

export class BunBackend {
  readonly channel: BackendChannel;
  readonly exited: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private failure: Error | undefined;

  constructor(
    launch: BackendLaunch,
    diagnostic: (line: string) => void,
    secrets: readonly string[] = [],
  ) {
    const env = { ...process.env };
    for (const name of [
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS',
      'BUN_OPTIONS',
      'KIMI_BROWSER_MCP_TEST_TOKEN',
    ])
      delete env[name];
    this.child = spawn(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.channel = new BackendChannel('electron', this.child.stdout, this.child.stdin);
    this.exited = new Promise<void>((resolve) => {
      this.child.once('error', () => {
        this.failure = new Error('Desktop Bun backend could not be spawned');
        this.channel.close(this.failure);
      });
      this.child.once('close', (code, signal) => {
        this.closed = true;
        if (this.closePromise === undefined || (code !== 0 && code !== null)) {
          this.failure ??= new Error(
            `Desktop Bun backend exited (code=${code ?? 'none'}, signal=${signal ?? 'none'})`,
          );
        }
        this.channel.close(this.failure ?? new Error('Desktop Bun backend exited'));
        resolve();
      });
    });
    let line = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      line += chunk;
      while (line.includes('\n')) {
        const end = line.indexOf('\n');
        let message = line.slice(0, end);
        line = line.slice(end + 1);
        for (const secret of secrets)
          if (secret !== '') message = message.replaceAll(secret, '[redacted]');
        diagnostic(message.slice(0, 8192));
      }
      if (line.length > 16384) {
        diagnostic('[kimi-desktop] oversized backend diagnostic omitted');
        line = '';
      }
    });
    this.channel.onDisconnect((error) => {
      if (this.closePromise !== undefined || this.closed) return;
      this.failure ??= error;
      diagnostic(
        '[kimi-desktop] Bun backend control channel disconnected; closing the owned backend',
      );
      void this.close().catch(() =>
        diagnostic('[kimi-desktop] Bun backend failed to close cleanly'),
      );
    });
  }

  get connected(): boolean {
    return !this.closed && this.closePromise === undefined && this.channel.connected;
  }

  async start(input: BackendInput<'start'>, signal?: AbortSignal): Promise<BackendOutput<'start'>> {
    if (!this.connected) throw new BackendRequestError('closing', 'Desktop backend is closing');
    try {
      const ready = await this.channel.request('start', input, { signal, timeoutMs: 120_000 });
      if (!this.connected)
        throw new BackendRequestError('closing', 'Desktop backend closed during startup');
      return ready;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= (async () => {
      if (this.closed) return;
      let forced = false;
      const watchdog = setTimeout(() => {
        forced = true;
        this.child.kill('SIGKILL');
      }, 10_000);
      let shutdownError: unknown;
      try {
        if (this.channel.connected) {
          try {
            await this.channel.request('shutdown', null, { timeoutMs: 9000 });
          } catch (error) {
            shutdownError = error;
          }
        }
        this.child.stdin.end();
        await this.exited;
      } finally {
        clearTimeout(watchdog);
        this.channel.close();
      }
      if (forced)
        throw new Error('Desktop backend required forced termination after shutdown timed out');
      if (shutdownError !== undefined) throw shutdownError as Error;
      if (this.failure !== undefined) throw this.failure;
    })());
  }
}
