/**
 * `kimi web` foreground teardown.
 *
 * The shutdown path used to share one `try` between `close()` and the telemetry
 * flush while reporting failures only through a logger that defaults to
 * `silent`, and it always exited 0 — so a failed `v2.close()` was invisible and
 * scripts could not tell a clean stop from a broken one. These tests pin the
 * per-step isolation, the failure names and the exit code.
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startServer: vi.fn(),
  close: vi.fn(),
  shutdownTelemetry: vi.fn(),
  track: vi.fn(),
  initializeServerTelemetry: vi.fn(),
  createServerLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@moonshot-ai/kap-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kap-server')>();
  return {
    ...actual,
    startServer: mocks.startServer,
    createServerLogger: mocks.createServerLogger,
  };
});

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  track: mocks.track,
  shutdownTelemetry: mocks.shutdownTelemetry,
}));

vi.mock('#/cli/telemetry', () => ({
  initializeServerTelemetry: mocks.initializeServerTelemetry,
}));

import { runShutdownSteps, shutdownExitCode, startServerForeground } from '#/cli/sub/web/run';
import type { ParsedServerOptions } from '#/cli/sub/web/shared';

const parsedOptions = {
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  insecureNoTls: true,
  allowRemoteShutdown: false,
  dangerousBypassAuth: true,
  open: false,
  debugEndpoints: false,
} as unknown as ParsedServerOptions;

let exitCodes: number[];

beforeEach(() => {
  exitCodes = [];
  mocks.close.mockResolvedValue(undefined);
  mocks.shutdownTelemetry.mockResolvedValue(undefined);
  mocks.startServer.mockResolvedValue({
    host: '127.0.0.1',
    port: 4321,
    close: mocks.close,
  });
  // A real `process.exit` never returns; the shutdown path relies on that, so
  // record the code without unwinding (throwing here would surface as an
  // unhandled rejection from the runner's fire-and-forget `void shutdown()`).
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(Number(code ?? 0));
    return undefined as never;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      process.off(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * Drive the real foreground runner to its shutdown path: the SIGINT listener is
 * registered once the server is "listening", so emitting the signal is
 * equivalent to the user pressing Ctrl+C. `shutdown()` ends in `process.exit`,
 * which the spy turns into a throw inside the runner's own `void shutdown(...)`
 * chain — the runner's promise never settles, so wait on the observed exit.
 */
async function runToShutdown(
  hooks: Parameters<typeof startServerForeground>[1] = {},
): Promise<void> {
  const pending = startServerForeground(parsedOptions, hooks);
  pending.catch(() => {});
  await vi.waitFor(() => {
    expect(process.listeners('SIGINT').length).toBeGreaterThan(0);
  });
  const handler = process.listeners('SIGINT').at(-1)!;
  process.off('SIGINT', handler);
  handler(new EventEmitter() as never);
  await vi.waitFor(() => {
    expect(exitCodes.length).toBeGreaterThan(0);
  });
}

describe('runShutdownSteps', () => {
  it('returns no failures when every step succeeds and runs them in order', async () => {
    const ran: string[] = [];
    const failures = await runShutdownSteps([
      { name: 'onShutdown', run: () => {
          ran.push('onShutdown');
        } },
      { name: 'close', run: () => {
          ran.push('close');
        } },
      { name: 'telemetry', run: () => {
          ran.push('telemetry');
        } },
    ]);

    expect(failures).toEqual([]);
    expect(ran).toEqual(['onShutdown', 'close', 'telemetry']);
    expect(shutdownExitCode(failures)).toBe(0);
  });

  it('keeps running later steps after a failure and names the failed step', async () => {
    const ran: string[] = [];
    const failures = await runShutdownSteps([
      { name: 'onShutdown', run: () => {
          ran.push('onShutdown');
        } },
      {
        name: 'close',
        run: () => {
          ran.push('close');
          throw new Error('close failed');
        },
      },
      { name: 'telemetry', run: () => {
          ran.push('telemetry');
        } },
    ]);

    expect(failures).toEqual(['close']);
    // The telemetry flush must not be skipped just because `close` rejected.
    expect(ran).toEqual(['onShutdown', 'close', 'telemetry']);
    expect(shutdownExitCode(failures)).toBe(1);
  });

  it('attempts close even when the shutdown hook rejects', async () => {
    const ran: string[] = [];
    const failures = await runShutdownSteps([
      {
        name: 'onShutdown',
        run: () => {
          ran.push('onShutdown');
          throw new Error('hook failed');
        },
      },
      { name: 'close', run: () => {
          ran.push('close');
        } },
      { name: 'telemetry', run: () => {
          ran.push('telemetry');
        } },
    ]);

    expect(failures).toEqual(['onShutdown']);
    expect(ran).toEqual(['onShutdown', 'close', 'telemetry']);
    expect(shutdownExitCode(failures)).toBe(1);
  });

  it('awaits async steps', async () => {
    const failures = await runShutdownSteps([
      { name: 'close', run: () => Promise.reject(new Error('nope')) },
    ]);

    expect(failures).toEqual(['close']);
  });
});

describe('startServerForeground shutdown', () => {
  it('exits 0 and flushes telemetry on a clean stop', async () => {
    await runToShutdown();

    expect(exitCodes).toEqual([0]);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it('exits 1 but still flushes telemetry when close fails', async () => {
    mocks.close.mockRejectedValue(new Error('cannot release the lock'));
    await runToShutdown();

    expect(exitCodes).toEqual([1]);
    expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it('exits 1 and still closes the server when the shutdown hook fails', async () => {
    const seen: string[] = [];
    await runToShutdown({
      onShutdown: () => {
        seen.push('hook');
        throw new Error('remote control teardown failed');
      },
    });

    expect(seen).toEqual(['hook']);
    expect(exitCodes).toEqual([1]);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it('writes the failed step to stderr', async () => {
    mocks.close.mockRejectedValue(new Error('cannot release the lock'));
    const stderr = vi.mocked(process.stderr.write);

    await runToShutdown();

    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('close');
  });
});
