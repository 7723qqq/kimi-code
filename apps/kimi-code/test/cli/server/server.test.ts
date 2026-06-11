/**
 * Tests for `kimi server run` and `kimi web` Commander wiring.
 *
 * These tests don't actually start the server — they verify the parsed shape
 * (option flags, --open default) and that the `web` alias defers to the same
 * underlying handler with `defaultOpen` flipped to true.
 *
 * Foreground startup behavior is exercised end-to-end in `server-e2e/`.
 */

import { readFileSync } from 'node:fs';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerServerCommand } from '#/cli/sub/server';

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerServerCommand(program);
  return program;
}

describe('kimi server', () => {
  it('declares pino-pretty as a CLI runtime dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).toHaveProperty('pino-pretty');
  });

  it('registers `server` with all six lifecycle subcommands plus `run`', () => {
    const program = makeProgram();
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    const subs = server?.commands.map((c) => c.name()).toSorted();
    expect(subs).toEqual(['install', 'restart', 'run', 'start', 'status', 'stop', 'uninstall']);
  });

  it('`server run` exposes --host, --port, --log-level, --debug-endpoints, --open', () => {
    const program = makeProgram();
    const run = program.commands
      .find((c) => c.name() === 'server')
      ?.commands.find((c) => c.name() === 'run');
    expect(run).toBeDefined();
    const longs = run!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--host');
    expect(longs).toContain('--port');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
    // run defaults to NOT opening the browser → option is the positive --open
    expect(longs).toContain('--open');
  });

  it('`server install` exposes --host, --port, --log-level, --force, --json', () => {
    const program = makeProgram();
    const install = program.commands
      .find((c) => c.name() === 'server')
      ?.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    const longs = install!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--host');
    expect(longs).toContain('--port');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--force');
    expect(longs).toContain('--json');
  });

  it('the top-level `kimi web` alias is registered and defaults to opening the browser', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const longs = web!.options.map((o) => o.long).filter(Boolean);
    // web defaults to opening → the option is the negative form --no-open
    expect(longs).toContain('--no-open');
    expect(longs).toContain('--host');
    expect(longs).toContain('--port');
  });
});

describe('`kimi server` lifecycle exits with ESERVICE_UNSUPPORTED on unsupported platforms', () => {
  it('the dispatcher returns a friendly error manager for unknown platforms', async () => {
    // darwin / linux / win32 have real backends (launchd / systemd / schtasks).
    // The remaining platforms fall through to the stub that throws
    // `ServiceUnsupportedError` — pin that contract so a future addition
    // (freebsd, etc.) needs a deliberate decision instead of silently working.
    const { resolveServiceManager, ServiceUnsupportedError } = await import('@moonshot-ai/server');
    const mgr = resolveServiceManager('freebsd');
    await expect(
      mgr.install({ host: '127.0.0.1', port: 7878, logLevel: 'info' }),
    ).rejects.toBeInstanceOf(ServiceUnsupportedError);
    await expect(mgr.status()).rejects.toBeInstanceOf(ServiceUnsupportedError);
  });
});

describe('`kimi server` does not register a legacy `daemon` command', () => {
  it('hard-deletes the old name', () => {
    const program = makeProgram();
    const daemon = program.commands.find((c) => c.name() === 'daemon');
    expect(daemon).toBeUndefined();
  });
});

describe('shared parsers stay strict', () => {
  it('rejects out-of-range --port', async () => {
    const { parsePort } = await import('#/cli/sub/server/shared');
    expect(() => parsePort('99999', '--port', 7878)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 7878)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 7878)).toBe(7878);
    expect(parsePort('8080', '--port', 7878)).toBe(8080);
  });

  it('rejects unknown --log-level values', async () => {
    const { parseLogLevel } = await import('#/cli/sub/server/shared');
    expect(() => parseLogLevel('shout')).toThrow(/invalid --log-level/);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
  });
});

// Silence vi import for cases where the file is built before tests reference vi.
void vi;
