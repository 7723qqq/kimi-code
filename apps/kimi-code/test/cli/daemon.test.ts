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

    expect(deps.ensureDaemonRunning).toHaveBeenCalledWith({
      host: DEFAULT_DAEMON_HOST,
      port: DEFAULT_DAEMON_PORT,
      logLevel: 'info',
      debugEndpoints: false,
    });
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
});
