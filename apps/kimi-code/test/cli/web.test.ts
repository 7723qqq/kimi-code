import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_ORIGIN,
  DEFAULT_DAEMON_PORT,
} from '#/cli/sub/daemon';
import {
  handleWebCommand,
  registerWebCommand,
  type WebCommandDeps,
} from '#/cli/sub/web';

function makeDeps(overrides: Partial<WebCommandDeps> = {}): {
  deps: WebCommandDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    deps: {
      ensureDaemonRunning: vi.fn(async () => ({
        status: 'already-running' as const,
        origin: DEFAULT_DAEMON_ORIGIN,
        pid: 1234,
      })),
      ensureDaemonWebReady: vi.fn(async () => undefined),
      openUrl: vi.fn(),
      stdout: { write: (chunk) => stdout.push(String(chunk)) > 0 },
      stderr: { write: (chunk) => stderr.push(String(chunk)) > 0 },
      ...overrides,
    },
    stdout,
    stderr,
  };
}

describe('kimi web', () => {
  it('registers web as a subcommand', () => {
    const program = new Command('kimi');
    registerWebCommand(program);

    const web = program.commands.find((cmd) => cmd.name() === 'web');
    expect(web).toBeDefined();
    expect(web?.options.some((option) => option.long === '--daemon-host')).toBe(true);
  });

  it('ensures the local daemon and opens the daemon-hosted web UI by default', async () => {
    const { deps, stdout, stderr } = makeDeps();

    await handleWebCommand({}, deps);

    expect(deps.ensureDaemonRunning).toHaveBeenCalledWith({
      host: DEFAULT_DAEMON_HOST,
      port: DEFAULT_DAEMON_PORT,
      logLevel: 'info',
      debugEndpoints: false,
    });
    expect(deps.ensureDaemonWebReady).toHaveBeenCalledWith(DEFAULT_DAEMON_ORIGIN);
    expect(deps.openUrl).toHaveBeenCalledWith(DEFAULT_DAEMON_ORIGIN);
    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain(`Kimi web: ${DEFAULT_DAEMON_ORIGIN}`);
  });

  it('opens the provided daemon host directly without starting local services', async () => {
    const { deps } = makeDeps();

    await handleWebCommand({ daemonHost: 'http://192.168.97.91:7878' }, deps);

    expect(deps.ensureDaemonRunning).not.toHaveBeenCalled();
    expect(deps.ensureDaemonWebReady).toHaveBeenCalledWith('http://192.168.97.91:7878');
    expect(deps.openUrl).toHaveBeenCalledWith('http://192.168.97.91:7878');
  });

  it('uses --port as the local daemon start port when --daemon-host is absent', async () => {
    const { deps } = makeDeps({
      ensureDaemonRunning: vi.fn(async () => ({
        status: 'already-running' as const,
        origin: 'http://127.0.0.1:8899',
        pid: 1234,
      })),
    });

    await handleWebCommand({ host: '0.0.0.0', port: '8899' }, deps);

    expect(deps.ensureDaemonRunning).toHaveBeenCalledWith({
      host: '0.0.0.0',
      port: 8899,
      logLevel: 'info',
      debugEndpoints: false,
    });
    expect(deps.ensureDaemonWebReady).toHaveBeenCalledWith('http://127.0.0.1:8899');
    expect(deps.openUrl).toHaveBeenCalledWith('http://127.0.0.1:8899');
  });

  it('respects --no-open while still printing the daemon-hosted web URL', async () => {
    const { deps, stdout } = makeDeps();

    await handleWebCommand({ daemonHost: 'http://example.test:9000/api/v1/', open: false }, deps);

    expect(deps.ensureDaemonRunning).not.toHaveBeenCalled();
    expect(deps.ensureDaemonWebReady).toHaveBeenCalledWith('http://example.test:9000');
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(stdout.join('')).toContain('Kimi web: http://example.test:9000');
  });

  it('does not open a daemon that does not serve the web UI', async () => {
    const { deps, stdout } = makeDeps({
      ensureDaemonWebReady: vi.fn(async () => {
        throw new Error('Daemon at http://127.0.0.1:7878 does not serve the Kimi web UI.');
      }),
    });

    await expect(handleWebCommand({}, deps)).rejects.toThrow('does not serve the Kimi web UI');

    expect(deps.ensureDaemonWebReady).toHaveBeenCalledWith(DEFAULT_DAEMON_ORIGIN);
    expect(deps.openUrl).not.toHaveBeenCalled();
    expect(stdout.join('')).toBe('');
  });
});
