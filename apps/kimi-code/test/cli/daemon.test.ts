import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_ORIGIN,
  DEFAULT_DAEMON_PORT,
  handleDaemonCommand,
  ensureDaemonRunning,
  registerDaemonCommand,
  type DaemonCommandDeps,
  type EnsureDaemonRunningDeps,
} from '#/cli/sub/daemon';

function makeDeps(overrides: Partial<DaemonCommandDeps> = {}): {
  deps: DaemonCommandDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      ensureDaemonRunning: vi.fn(async () => ({
        status: 'started' as const,
        origin: DEFAULT_DAEMON_ORIGIN,
        pid: 1234,
        logPath: '/tmp/kimi-daemon.log',
      })),
      startDaemonForeground: vi.fn(async () => undefined),
      stdout: { write: (chunk) => stdout.push(String(chunk)) > 0 },
      stderr: { write: (chunk) => stderr.push(String(chunk)) > 0 },
      ...overrides,
    },
    stdout,
    stderr,
  };
}

describe('kimi daemon', () => {
  it('registers daemon as a subcommand with a foreground option', () => {
    const program = new Command('kimi');
    registerDaemonCommand(program);

    const daemon = program.commands.find((cmd) => cmd.name() === 'daemon');
    expect(daemon).toBeDefined();
    expect(daemon?.options.some((option) => option.long === '--foreground')).toBe(true);
  });

  it('starts the daemon in the background by default', async () => {
    const { deps, stdout, stderr } = makeDeps();

    await handleDaemonCommand({}, deps);

    expect(deps.ensureDaemonRunning).toHaveBeenCalledWith(
      {
        host: DEFAULT_DAEMON_HOST,
        port: DEFAULT_DAEMON_PORT,
        logLevel: 'info',
        debugEndpoints: false,
        restart: false,
      },
      expect.any(Function),
    );
    expect(deps.startDaemonForeground).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain('Kimi daemon started in background');
    expect(stdout.join('')).toContain('/tmp/kimi-daemon.log');
  });

  it('does not start another background daemon when one is already running', async () => {
    const { deps, stdout, stderr } = makeDeps({
      ensureDaemonRunning: vi.fn(async () => ({
        status: 'already-running' as const,
        origin: DEFAULT_DAEMON_ORIGIN,
        pid: 4321,
      })),
    });

    await handleDaemonCommand({}, deps);

    expect(deps.ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(deps.ensureDaemonRunning).toHaveBeenCalledWith(
      {
        host: DEFAULT_DAEMON_HOST,
        port: DEFAULT_DAEMON_PORT,
        logLevel: 'info',
        debugEndpoints: false,
        restart: false,
      },
      expect.any(Function),
    );
    expect(deps.startDaemonForeground).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain('Kimi daemon already running');
    expect(stdout.join('')).toContain('4321');
  });

  it('keeps the daemon in the foreground when --foreground is set', async () => {
    const { deps, stdout, stderr } = makeDeps();

    await handleDaemonCommand({ foreground: true, port: '7879', logLevel: 'debug' }, deps);

    expect(deps.ensureDaemonRunning).not.toHaveBeenCalled();
    expect(deps.startDaemonForeground).toHaveBeenCalledWith({
      host: DEFAULT_DAEMON_HOST,
      port: 7879,
      logLevel: 'debug',
      debugEndpoints: false,
      restart: false,
    });
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('');
  });

  it('does not treat a live lock as running until health check succeeds', async () => {
    const parsedOptions = {
      host: DEFAULT_DAEMON_HOST,
      port: DEFAULT_DAEMON_PORT,
      logLevel: 'info' as const,
      debugEndpoints: false,
      restart: false,
    };
    const deps: EnsureDaemonRunningDeps = {
      isDaemonHealthy: vi.fn(async () => false),
      waitForDaemonHealthy: vi.fn(async () => false),
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: 8787,
      })),
      startDaemonBackground: vi.fn(() => ({
        pid: 9876,
        logPath: '/tmp/kimi-daemon.log',
      })),
      daemonLogPath: vi.fn(() => '/tmp/kimi-daemon.log'),
      currentBuild: vi.fn(() => ({ version: '1.0.0', entry: '/cli/main.mjs' })),
      stopDaemon: vi.fn(async () => true),
    };

    await expect(ensureDaemonRunning(parsedOptions, deps)).rejects.toThrow(
      'Kimi daemon did not become healthy',
    );

    expect(deps.waitForDaemonHealthy).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787',
      5000,
    );
    expect(deps.startDaemonBackground).toHaveBeenCalledWith(parsedOptions);
    expect(deps.waitForDaemonHealthy).toHaveBeenNthCalledWith(
      2,
      DEFAULT_DAEMON_ORIGIN,
      15_000,
    );
  });

  it('reports when a live daemon lock redirects to another daemon port', async () => {
    const parsedOptions = {
      host: DEFAULT_DAEMON_HOST,
      port: 7999,
      logLevel: 'info' as const,
      debugEndpoints: false,
      restart: false,
    };
    const status: string[] = [];
    const deps: EnsureDaemonRunningDeps = {
      isDaemonHealthy: vi.fn(async () => false),
      waitForDaemonHealthy: vi.fn(async () => true),
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: 7880,
        host_version: '1.0.0',
        entry: '/cli/main.mjs',
      })),
      startDaemonBackground: vi.fn(() => ({
        pid: 9876,
        logPath: '/tmp/kimi-daemon.log',
      })),
      daemonLogPath: vi.fn(() => '/tmp/kimi-daemon.log'),
      currentBuild: vi.fn(() => ({ version: '1.0.0', entry: '/cli/main.mjs' })),
      stopDaemon: vi.fn(async () => true),
    };

    await expect(
      ensureDaemonRunning(parsedOptions, deps, (message) => status.push(message)),
    ).resolves.toMatchObject({
      status: 'already-running',
      origin: 'http://127.0.0.1:7880',
      pid: 4321,
    });

    expect(status).toEqual([
      'checking requested daemon at http://127.0.0.1:7999',
      'requested daemon is not healthy',
      expect.stringContaining('checking daemon lock at '),
      'found live daemon lock (pid 4321, port 7880, started 2026-06-10T00:00:00.000Z)',
      'checking locked daemon at http://127.0.0.1:7880',
      'locked daemon is healthy; reusing http://127.0.0.1:7880',
    ]);
    expect(deps.startDaemonBackground).not.toHaveBeenCalled();
  });

  function makeEnsureDeps(overrides: Partial<EnsureDaemonRunningDeps> = {}): EnsureDaemonRunningDeps {
    return {
      isDaemonHealthy: vi.fn(async () => true),
      waitForDaemonHealthy: vi.fn(async () => true),
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: DEFAULT_DAEMON_PORT,
        host_version: '1.0.0',
        entry: '/old/main.mjs',
      })),
      startDaemonBackground: vi.fn(() => ({ pid: 9876, logPath: '/tmp/kimi-daemon.log' })),
      daemonLogPath: vi.fn(() => '/tmp/kimi-daemon.log'),
      currentBuild: vi.fn(() => ({ version: '1.0.0', entry: '/old/main.mjs' })),
      stopDaemon: vi.fn(async () => true),
      ...overrides,
    };
  }

  const parsedDefaults = {
    host: DEFAULT_DAEMON_HOST,
    port: DEFAULT_DAEMON_PORT,
    logLevel: 'info' as const,
    debugEndpoints: false,
    restart: false,
  };

  it('reuses a healthy daemon that was started by the same build', async () => {
    const deps = makeEnsureDeps();

    await expect(ensureDaemonRunning(parsedDefaults, deps)).resolves.toMatchObject({
      status: 'already-running',
      origin: DEFAULT_DAEMON_ORIGIN,
      pid: 4321,
    });
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(deps.startDaemonBackground).not.toHaveBeenCalled();
  });

  it('warns but reuses a build-mismatched daemon without --restart', async () => {
    const status: string[] = [];
    const deps = makeEnsureDeps({
      currentBuild: vi.fn(() => ({ version: '2.0.0', entry: '/new/main.mjs' })),
    });

    await expect(
      ensureDaemonRunning(parsedDefaults, deps, (m) => status.push(m)),
    ).resolves.toMatchObject({
      status: 'already-running',
      origin: DEFAULT_DAEMON_ORIGIN,
      pid: 4321,
    });
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(deps.startDaemonBackground).not.toHaveBeenCalled();
    expect(status).toContain(
      'running daemon is a different build (running 1.0.0, current 2.0.0); rerun with --restart to replace it',
    );
  });

  it('warns about a different install of the same version without --restart', async () => {
    const status: string[] = [];
    const deps = makeEnsureDeps({
      currentBuild: vi.fn(() => ({ version: '1.0.0', entry: '/new/main.mjs' })),
    });

    await expect(
      ensureDaemonRunning(parsedDefaults, deps, (m) => status.push(m)),
    ).resolves.toMatchObject({ status: 'already-running' });
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(status).toContain(
      'running daemon is a different install of 1.0.0 (/old/main.mjs); rerun with --restart to replace it',
    );
  });

  it('warns about a lock without build identity (older daemon) without --restart', async () => {
    const status: string[] = [];
    const deps = makeEnsureDeps({
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: DEFAULT_DAEMON_PORT,
      })),
      currentBuild: vi.fn(() => ({ version: '2.0.0', entry: '/new/main.mjs' })),
    });

    await expect(
      ensureDaemonRunning(parsedDefaults, deps, (m) => status.push(m)),
    ).resolves.toMatchObject({ status: 'already-running' });
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(status).toContain(
      'running daemon is a different build (running unknown build, current 2.0.0); rerun with --restart to replace it',
    );
  });

  it('stops the running daemon and starts fresh with --restart (even on the same build)', async () => {
    const status: string[] = [];
    const deps = makeEnsureDeps();
    const parsed = { ...parsedDefaults, restart: true };

    await expect(
      ensureDaemonRunning(parsed, deps, (m) => status.push(m)),
    ).resolves.toMatchObject({ status: 'started', origin: DEFAULT_DAEMON_ORIGIN, pid: 9876 });

    expect(deps.stopDaemon).toHaveBeenCalledWith(4321);
    expect(deps.startDaemonBackground).toHaveBeenCalledWith(parsed);
    expect(status).toContain('--restart: stopping daemon (pid 4321)');
    expect(status).toContain('stopped daemon (pid 4321)');
  });

  it('keeps using the running daemon when --restart cannot stop it', async () => {
    const status: string[] = [];
    const deps = makeEnsureDeps({
      stopDaemon: vi.fn(async () => false),
    });

    await expect(
      ensureDaemonRunning({ ...parsedDefaults, restart: true }, deps, (m) => status.push(m)),
    ).resolves.toMatchObject({
      status: 'already-running',
      origin: DEFAULT_DAEMON_ORIGIN,
      pid: 4321,
    });
    expect(deps.startDaemonBackground).not.toHaveBeenCalled();
    expect(status).toContain(
      `could not stop daemon (pid 4321); using ${DEFAULT_DAEMON_ORIGIN} as-is`,
    );
  });

  it('never stops a daemon whose lock does not match the requested port', async () => {
    // e.g. a stub daemon occupying the port while the lock belongs to a daemon
    // on another port — --restart must not SIGTERM the unrelated lock pid.
    const deps = makeEnsureDeps({
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: 9999,
        host_version: '1.0.0',
        entry: '/old/main.mjs',
      })),
    });

    await expect(
      ensureDaemonRunning({ ...parsedDefaults, restart: true }, deps),
    ).resolves.toMatchObject({
      status: 'already-running',
      origin: DEFAULT_DAEMON_ORIGIN,
      pid: undefined,
    });
    expect(deps.stopDaemon).not.toHaveBeenCalled();
  });

  it('restarts a daemon found via the lock on another port with --restart', async () => {
    const deps = makeEnsureDeps({
      isDaemonHealthy: vi.fn(async () => false),
      waitForDaemonHealthy: vi.fn(async () => true),
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: 9999,
        host_version: '1.0.0',
        entry: '/old/main.mjs',
      })),
    });
    const parsed = { ...parsedDefaults, restart: true };

    await expect(ensureDaemonRunning(parsed, deps)).resolves.toMatchObject({
      status: 'started',
      origin: DEFAULT_DAEMON_ORIGIN,
    });
    expect(deps.stopDaemon).toHaveBeenCalledWith(4321);
    expect(deps.startDaemonBackground).toHaveBeenCalledWith(parsed);
  });

  it('warns but reuses a build-mismatched daemon on another port without --restart', async () => {
    const status: string[] = [];
    const deps = makeEnsureDeps({
      isDaemonHealthy: vi.fn(async () => false),
      waitForDaemonHealthy: vi.fn(async () => true),
      readLiveDaemonLock: vi.fn(() => ({
        pid: 4321,
        started_at: '2026-06-10T00:00:00.000Z',
        port: 9999,
        host_version: '1.0.0',
        entry: '/old/main.mjs',
      })),
      currentBuild: vi.fn(() => ({ version: '2.0.0', entry: '/new/main.mjs' })),
    });

    await expect(
      ensureDaemonRunning(parsedDefaults, deps, (m) => status.push(m)),
    ).resolves.toMatchObject({
      status: 'already-running',
      origin: 'http://127.0.0.1:9999',
      pid: 4321,
    });
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(status).toContain(
      'running daemon is a different build (running 1.0.0, current 2.0.0); rerun with --restart to replace it',
    );
  });
});
