/**
 * `kimi daemon` sub-command.
 *
 * Default mode starts the daemon as a detached background process and exits
 * after the daemon becomes healthy. `--foreground` keeps the daemon attached
 * to the current terminal.
 */

import type { Command } from 'commander';

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  DaemonLockedError,
  DEFAULT_LOCK_PATH,
  startDaemon,
  type DaemonLogLevel,
} from '@moonshot-ai/daemon';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity, getHostPackageRoot, getVersion } from '../version';

export const DEFAULT_DAEMON_HOST = '127.0.0.1';
export const DEFAULT_DAEMON_PORT = 7878;
export const DEFAULT_DAEMON_ORIGIN = daemonOrigin(DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT);
const DEFAULT_LOG_LEVEL: DaemonLogLevel = 'info';
const WEB_ASSETS_DIR = 'dist-web';
const VALID_LOG_LEVELS: readonly DaemonLogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export interface DaemonCliOptions {
  host?: string;
  port?: string;
  logLevel?: string;
  debugEndpoints?: boolean;
  foreground?: boolean;
  restart?: boolean;
}

export interface ParsedDaemonOptions {
  host: string;
  port: number;
  logLevel: DaemonLogLevel;
  debugEndpoints: boolean;
  /** Stop a running managed daemon and start a fresh one with this CLI build. */
  restart: boolean;
}

export type EnsureDaemonResult =
  | {
      status: 'already-running';
      origin: string;
      pid?: number;
      logPath?: string;
    }
  | {
      status: 'started';
      origin: string;
      pid: number;
      logPath: string;
    };

export type DaemonStartupReporter = (message: string) => void;

export interface EnsureDaemonRunningDeps {
  isDaemonHealthy(origin: string, timeoutMs: number): Promise<boolean>;
  waitForDaemonHealthy(origin: string, timeoutMs: number): Promise<boolean>;
  readLiveDaemonLock(): DaemonLockContents | undefined;
  startDaemonBackground(options: ParsedDaemonOptions): { pid: number; logPath: string };
  daemonLogPath(): string;
  /** Identity of the CLI build that is executing right now. */
  currentBuild(): BuildIdentity;
  /** SIGTERM the daemon and wait for the pid to exit. Resolves false on timeout/EPERM. */
  stopDaemon(pid: number): Promise<boolean>;
}

/** What identifies "the same build": the host version PLUS the entry path —
    two pkg.pr.new installs of the same base version live at different paths. */
export interface BuildIdentity {
  version: string;
  entry: string | undefined;
}

export interface DaemonCommandDeps {
  ensureDaemonRunning(
    options: ParsedDaemonOptions,
    report?: DaemonStartupReporter,
  ): Promise<EnsureDaemonResult>;
  startDaemonForeground(options: ParsedDaemonOptions): Promise<void>;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export function registerDaemonCommand(parent: Command): void {
  parent
    .command('daemon')
    .description('Run the local kimi-code daemon (REST + WebSocket).')
    .option(
      '--host <host>',
      `Bind host for the daemon (default ${DEFAULT_DAEMON_HOST})`,
      DEFAULT_DAEMON_HOST,
    )
    .option(
      '--port <port>',
      `Bind port for the daemon (default ${DEFAULT_DAEMON_PORT})`,
      String(DEFAULT_DAEMON_PORT),
    )
    .option(
      '--log-level <level>',
      `Log level: ${VALID_LOG_LEVELS.join('|')} (default ${DEFAULT_LOG_LEVEL})`,
      DEFAULT_LOG_LEVEL,
    )
    .option(
      '--foreground',
      'Run the daemon in the foreground instead of starting a background daemon.',
      false,
    )
    .option(
      '--restart',
      'Stop the running daemon (if this CLI manages it) and start a fresh one with this build.',
      false,
    )
    .option(
      '--debug-endpoints',
      'Mount /api/v1/debug/* routes for test introspection (per-session shadow + dispatch log). OFF by default; production callers leave this unset.',
      false,
    )
    .action(async (opts: DaemonCliOptions) => {
      try {
        await handleDaemonCommand(opts);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}

export async function handleDaemonCommand(
  opts: DaemonCliOptions,
  deps: DaemonCommandDeps = DEFAULT_DAEMON_COMMAND_DEPS,
): Promise<void> {
  const parsed = parseDaemonOptions(opts);
  if (opts.foreground === true) {
    try {
      await deps.startDaemonForeground(parsed);
    } catch (error) {
      if (error instanceof DaemonLockedError) {
        deps.stdout.write(formatAlreadyRunning(error.existing.port, error.existing.pid));
        return;
      }
      throw error;
    }
    return;
  }

  const result = await deps.ensureDaemonRunning(parsed, (message) => {
    writeDaemonStartupStatus(deps.stdout, message);
  });
  if (result.status === 'already-running') {
    deps.stdout.write(
      `Kimi daemon already running at ${result.origin}${formatPid(result.pid)}.\n`,
    );
    if (result.logPath !== undefined) {
      deps.stdout.write(`Logs: ${result.logPath}\n`);
    }
    return;
  }

  deps.stdout.write(
    `Kimi daemon started in background at ${result.origin} (pid ${result.pid}).\n`,
  );
  deps.stdout.write(`Logs: ${result.logPath}\n`);
}

export function parseDaemonOptions(opts: DaemonCliOptions): ParsedDaemonOptions {
  return {
    host: opts.host ?? DEFAULT_DAEMON_HOST,
    port: parsePort(opts.port, '--port', DEFAULT_DAEMON_PORT),
    logLevel: parseLogLevel(opts.logLevel),
    debugEndpoints: opts.debugEndpoints === true,
    restart: opts.restart === true,
  };
}

export function parsePort(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`error: invalid ${label} value: ${raw}`);
  }
  return n;
}

export function parseLogLevel(raw: string | undefined): DaemonLogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  if ((VALID_LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as DaemonLogLevel;
  }
  throw new Error(
    `error: invalid --log-level value: ${raw} (allowed: ${VALID_LOG_LEVELS.join(', ')})`,
  );
}

export async function ensureDaemonRunning(
  options: ParsedDaemonOptions,
  deps: EnsureDaemonRunningDeps = DEFAULT_ENSURE_DAEMON_RUNNING_DEPS,
  report: DaemonStartupReporter = () => {},
): Promise<EnsureDaemonResult> {
  const origin = daemonOrigin(options.host, options.port);
  report(`checking requested daemon at ${origin}`);
  if (await deps.isDaemonHealthy(origin, 1000)) {
    const lock = deps.readLiveDaemonLock();
    // Only a lock recorded for THIS port describes the daemon we just probed —
    // a foreign healthy process on the port (or a daemon on another port
    // holding the lock) is not ours to manage, so use it as-is.
    const ownedLock = lock !== undefined && lock.port === options.port ? lock : undefined;
    const reuse = (): EnsureDaemonResult => ({
      status: 'already-running',
      origin,
      pid: ownedLock?.pid,
      logPath: deps.daemonLogPath(),
    });
    if (ownedLock === undefined) {
      if (options.restart) {
        report(`--restart: daemon at ${origin} is not managed by this CLI (no matching lock); using it as-is`);
      }
      report(`requested daemon is healthy; using ${origin}`);
      return reuse();
    }
    if (!options.restart) {
      // A daemon from another build keeps serving its OWN bundled web UI/API —
      // surface the mismatch so the user knows the running daemon lags the CLI
      // they just invoked, but never replace it without an explicit --restart.
      if (!lockMatchesBuild(ownedLock, deps.currentBuild())) {
        report(describeBuildMismatch(ownedLock, deps.currentBuild()));
      }
      report(`requested daemon is healthy; using ${origin}`);
      return reuse();
    }
    report(`--restart: stopping daemon (pid ${ownedLock.pid})`);
    if (!(await deps.stopDaemon(ownedLock.pid))) {
      report(`could not stop daemon (pid ${ownedLock.pid}); using ${origin} as-is`);
      return reuse();
    }
    report(`stopped daemon (pid ${ownedLock.pid})`);
  } else {
    report('requested daemon is not healthy');
    report(`checking daemon lock at ${DEFAULT_LOCK_PATH}`);
    const lock = deps.readLiveDaemonLock();
    if (lock !== undefined) {
      report(
        `found live daemon lock (pid ${lock.pid}, port ${lock.port}, started ${lock.started_at})`,
      );
      const lockOrigin = daemonOrigin(options.host, lock.port);
      report(`checking locked daemon at ${lockOrigin}`);
      if (await deps.waitForDaemonHealthy(lockOrigin, 5000)) {
        const reuseLocked = (): EnsureDaemonResult => ({
          status: 'already-running',
          origin: lockOrigin,
          pid: lock.pid,
          logPath: deps.daemonLogPath(),
        });
        if (!options.restart) {
          if (!lockMatchesBuild(lock, deps.currentBuild())) {
            report(describeBuildMismatch(lock, deps.currentBuild()));
          }
          report(`locked daemon is healthy; reusing ${lockOrigin}`);
          return reuseLocked();
        }
        report(`--restart: stopping daemon (pid ${lock.pid})`);
        if (!(await deps.stopDaemon(lock.pid))) {
          report(`could not stop daemon (pid ${lock.pid}); using ${lockOrigin} as-is`);
          return reuseLocked();
        }
        report(`stopped daemon (pid ${lock.pid})`);
      } else {
        report(`locked daemon did not become healthy at ${lockOrigin}`);
      }
    } else {
      report('no live daemon lock found');
    }
  }

  report(`starting daemon in background at ${origin}`);
  const started = deps.startDaemonBackground(options);
  const ready = await deps.waitForDaemonHealthy(origin, 15_000);
  if (!ready) {
    report(`daemon did not become healthy at ${origin}`);
    throw new Error(
      `Kimi daemon did not become healthy at ${origin}. Check logs: ${started.logPath}`,
    );
  }
  report(`daemon is healthy at ${origin}`);
  return {
    status: 'started',
    origin,
    pid: started.pid,
    logPath: started.logPath,
  };
}

export async function startDaemonForeground(options: ParsedDaemonOptions): Promise<void> {
  const version = getVersion();
  const running = await startDaemon({
    host: options.host,
    port: options.port,
    logLevel: options.logLevel,
    debugEndpoints: options.debugEndpoints,
    webAssetsDir: daemonWebAssetsDir(),
    coreProcessOptions: {
      identity: createKimiCodeHostIdentity(version),
    },
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    running.logger.info({ signal }, 'daemon shutting down');
    try {
      await running.close();
      process.exit(0);
    } catch (error) {
      running.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'daemon shutdown error',
      );
      process.exit(1);
    }
  };
  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal);
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

export function daemonOrigin(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function startDaemonBackground(options: ParsedDaemonOptions): { pid: number; logPath: string } {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
    throw new Error('Cannot start daemon: current CLI entry path is unavailable.');
  }

  const logPath = daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  const args = [
    ...process.execArgv,
    entry,
    'daemon',
    '--foreground',
    '--host',
    options.host,
    '--port',
    String(options.port),
    '--log-level',
    options.logLevel,
  ];
  if (options.debugEndpoints) {
    args.push('--debug-endpoints');
  }

  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
    return { pid: child.pid ?? -1, logPath };
  } finally {
    closeSync(logFd);
  }
}

function daemonLogPath(): string {
  return join(resolveKimiHome(), 'daemon', 'daemon.log');
}

function daemonWebAssetsDir(): string {
  return join(getHostPackageRoot(), WEB_ASSETS_DIR);
}

async function waitForDaemonHealthy(origin: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await isDaemonHealthy(origin, 500)) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  } while (Date.now() < deadline);
  return false;
}

async function isDaemonHealthy(origin: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/api/v1/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { code?: unknown };
    return body.code === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface DaemonLockContents {
  pid: number;
  started_at: string;
  port: number;
  /** Host CLI version that started the daemon (absent in locks from older builds). */
  host_version?: string;
  /** CLI entry path that spawned the daemon (absent in locks from older builds). */
  entry?: string;
}

/** True when the locked daemon was started by the SAME build as this CLI.
    Locks from older builds lack the identity fields → mismatch → restart. */
function lockMatchesBuild(lock: DaemonLockContents, build: BuildIdentity): boolean {
  return lock.host_version === build.version && lock.entry === build.entry;
}

function describeBuildMismatch(lock: DaemonLockContents, build: BuildIdentity): string {
  const running = lock.host_version ?? 'unknown build';
  if (running !== build.version) {
    return `running daemon is a different build (running ${running}, current ${build.version}); rerun with --restart to replace it`;
  }
  return `running daemon is a different install of ${running} (${lock.entry ?? 'unknown entry'}); rerun with --restart to replace it`;
}

function currentBuild(): BuildIdentity {
  return { version: getVersion(), entry: process.argv[1] };
}

/** SIGTERM the daemon and wait (≤5s) for the pid to exit. The daemon's signal
    handler closes the server and releases the lock file, so a fresh background
    start can take over cleanly. */
async function stopDaemonProcess(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    // ESRCH: already gone — that's a successful stop. EPERM etc.: not ours to kill.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
  }
  return false;
}

function readLiveDaemonLock(): DaemonLockContents | undefined {
  if (!existsSync(DEFAULT_LOCK_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_LOCK_PATH, 'utf-8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as DaemonLockContents).pid !== 'number' ||
      typeof (parsed as DaemonLockContents).port !== 'number' ||
      typeof (parsed as DaemonLockContents).started_at !== 'string'
    ) {
      return undefined;
    }
    const lock = parsed as DaemonLockContents;
    return pidAlive(lock.pid) ? lock : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function formatAlreadyRunning(port: number, pid: number): string {
  return `Kimi daemon already running at ${daemonOrigin(DEFAULT_DAEMON_HOST, port)} (pid ${pid}).\n`;
}

function formatPid(pid: number | undefined): string {
  return pid === undefined ? '' : ` (pid ${pid})`;
}

function writeDaemonStartupStatus(
  stdout: Pick<NodeJS.WriteStream, 'write'>,
  message: string,
): void {
  stdout.write(`Daemon startup: ${message}\n`);
}

const DEFAULT_DAEMON_COMMAND_DEPS: DaemonCommandDeps = {
  ensureDaemonRunning: (options, report) =>
    ensureDaemonRunning(options, DEFAULT_ENSURE_DAEMON_RUNNING_DEPS, report),
  startDaemonForeground,
  stdout: process.stdout,
  stderr: process.stderr,
};

const DEFAULT_ENSURE_DAEMON_RUNNING_DEPS: EnsureDaemonRunningDeps = {
  isDaemonHealthy,
  waitForDaemonHealthy,
  readLiveDaemonLock,
  startDaemonBackground,
  daemonLogPath,
  currentBuild,
  stopDaemon: stopDaemonProcess,
};
