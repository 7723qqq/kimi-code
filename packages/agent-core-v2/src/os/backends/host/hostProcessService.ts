import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';
import { LifecycleScope } from '#/app/scopes';
import { HostTimersService } from '#/os/backends/host/hostTimersService';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
  type HostProcessOptions,
  type IHostProcess,
} from '#/os/interface/hostProcess';
import { type IHostTimerHandle, type IHostTimers } from '#/os/interface/hostTimers';

const isWindows: boolean = process.platform === 'win32';
const TASKKILL_TIMEOUT_MS = 5_000;

interface BunSpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly detached: boolean;
  readonly windowsHide: boolean;
  readonly windowsVerbatimArguments?: boolean;
  readonly timeout?: number;
}

function buildSpawnOptions(options: HostProcessOptions): BunSpawnOptions {
  const detached = options.detached ?? !isWindows;
  return {
    cwd: options.cwd,
    env: buildEnv(options.env),
    detached,
    windowsHide: options.windowsHide ?? true,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };
}

function buildEnv(
  overrides: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (overrides === undefined) {
    return undefined;
  }
  return { ...(process.env as Record<string, string>), ...overrides };
}

interface ResolvedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: BunSpawnOptions;
}

function resolveWindowsSpawn(
  command: string,
  args: readonly string[],
  options: BunSpawnOptions,
  shell: string | boolean | undefined,
): ResolvedSpawn {
  if (shell !== undefined && shell !== false) {
    const joined = [command, ...args].join(' ');
    if (isWindows) {
      const host = typeof shell === 'string' ? shell : (process.env['ComSpec'] ?? 'cmd.exe');
      return {
        command: host,
        args: ['/d', '/s', '/c', `"${joined}"`],
        options: { ...options, windowsVerbatimArguments: true },
      };
    }
    const host = typeof shell === 'string' ? shell : '/bin/sh';
    return { command: host, args: ['-c', joined], options };
  }
  if (!isWindows) {
    return { command, args, options };
  }
  const script = findWindowsScript(command, options.env);
  if (script === undefined) {
    return { command, args, options };
  }
  const commandLine = [escapeCmdArg(script), ...args.map(escapeCmdArg)].join(' ');
  return {
    command: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    options: { ...options, windowsVerbatimArguments: true },
  };
}

function findWindowsScript(
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (/\.(cmd|bat)$/i.test(command)) return command;
  if (/\.(exe|com)$/i.test(command)) return undefined;
  const extensions = (env?.['PATHEXT'] ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0);
  const bases: string[] = [];
  if (command.includes('/') || command.includes('\\')) {
    bases.push(command);
  } else {
    bases.push(join(process.cwd(), command));
    const pathValue = env?.['PATH'] ?? process.env['PATH'] ?? '';
    for (const dir of pathValue.split(';')) {
      if (dir.length > 0) bases.push(join(dir, command));
    }
  }
  for (const base of bases) {
    for (const ext of extensions) {
      const candidate = base + ext;
      if (!isFile(candidate)) continue;
      return /\.(cmd|bat)$/i.test(candidate) ? candidate : undefined;
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function escapeCmdArg(arg: string): string {
  if (!/[ \t"&|<>^()%!]/.test(arg)) return arg;
  const escaped = arg.replaceAll('"', '""');
  const trailing = escaped.match(/\\+$/)?.[0] ?? '';
  return `"${escaped}${trailing}"`;
}

function streamToReadable(stream: ReadableStream<Uint8Array>): Readable {
  const readable = new Readable({ read() {} });
  const reader = stream.getReader();
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        readable.push(null);
        return;
      }
      if (value !== undefined && !readable.push(Buffer.from(value))) {
        await new Promise<void>((resolve) => readable.once('drain', resolve));
      }
    }
  };
  void pump().catch((error: unknown) => {
    readable.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return readable;
}

class HostProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number;

  private readonly _proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private readonly _timers: IHostTimers;
  private _exitCode: number | null = null;
  private readonly _exitPromise: Promise<number>;
  private _disposed = false;

  constructor(
    proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
    mergeStderr: boolean,
    timers: IHostTimers,
  ) {
    this._proc = proc;
    this._timers = timers;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        try {
          void proc.stdin.write(chunk);
          void proc.stdin.flush();
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
      final: (callback) => {
        const ended = proc.stdin.end() as number | Promise<unknown> | undefined;
        if (typeof ended === 'number' || ended === undefined) {
          callback();
          return;
        }
        ended.then(
          () => callback(),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
    this.stdout = new BufferedReadable(streamToReadable(proc.stdout));
    this.stderr = mergeStderr
      ? this.stdout
      : new BufferedReadable(streamToReadable(proc.stderr));
    this.pid = proc.pid;

    this._exitPromise = proc.exited.then(
      (code) => {
        this._exitCode = code;
        return code;
      },
      (error: unknown) => {
        throw error;
      },
    );
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  wait(): Promise<number> {
    return this._exitPromise;
  }

  async kill(signal?: NodeJS.Signals): Promise<void> {
    if (this.pid <= 0) {
      return;
    }

    if (isWindows) {
      let killer: Bun.Subprocess<'ignore', 'ignore', 'ignore'>;
      try {
        killer = Bun.spawn({
          cmd: ['taskkill', '/T', '/F', '/PID', String(this.pid)],
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
          windowsHide: true,
        });
      } catch {
        return;
      }
      let timeout: IHostTimerHandle | undefined;
      const exited = await Promise.race([
        killer.exited.then(() => true),
        new Promise<false>((resolve) => {
          timeout = this._timers.setTimeout(() => {
            resolve(false);
          }, TASKKILL_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
      if (timeout !== undefined) this._timers.clearTimeout(timeout);
      if (!exited) {
        killer.unref?.();
        try {
          killer.kill();
        } catch {}
      }
      return;
    }

    try {
      process.kill(-this.pid, signal ?? 'SIGTERM');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') return;
      if (err.code === 'EPERM') {
        try {
          this._proc.kill(signal ?? 'SIGTERM');
        } catch {}
        return;
      }
      throw new HostProcessError(
        HostProcessErrorCode.KillFailed,
        `Failed to kill process ${this.pid}: ${err.message}`,
        {
          details: { pid: this.pid, signal: signal ?? 'SIGTERM', errno: err.code },
          cause: error,
        },
      );
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.stdin.destroy();
    this.stdout.destroy();
    if (this.stderr !== this.stdout) {
      this.stderr.destroy();
    }
  }
}

export class HostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  readonly timers: IHostTimers;

  constructor(timers?: IHostTimers) {
    this.timers = timers ?? new HostTimersService();
  }

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    const spawnOptions = buildSpawnOptions(options);
    const resolved = resolveWindowsSpawn(command, args, spawnOptions, options.shell);
    let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      proc = Bun.spawn({
        cmd: [resolved.command, ...resolved.args],
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        ...resolved.options,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      throw new HostProcessError(
        HostProcessErrorCode.SpawnFailed,
        `Failed to spawn "${command}": ${err.message}`,
        {
          details: { command, args: [...args], cwd: options.cwd, errno: err.code },
          cause: error,
        },
      );
    }
    return new HostProcess(proc, options.mergeStderr ?? false, this.timers);
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostProcessService,
  HostProcessService,
  ScopeActivation.OnScopeCreated,
  'hostProcess',
);
