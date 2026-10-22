/**
 * `kimi web` foreground teardown.
 *
 * The shutdown path used to share one `try` between `close()` and the telemetry
 * flush while reporting failures only through a logger that defaults to
 * `silent`, and it always exited 0 — so a failed `v2.close()` was invisible and
 * scripts could not tell a clean stop from a broken one. These tests pin the
 * per-step isolation, the failure names and the exit code.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { waitForAssertion } from '#test/helpers/waitFor';

import * as kapServerModule from '@moonshot-ai/kap-server';
import type { ForegroundIO } from '#/cli/sub/web/run';

const mocks = (() => ({
  startServer: mock(),
  close: mock(),
  shutdownTelemetry: mock(),
  track: mock(),
  initializeServerTelemetry: mock(),
  createServerLogger: mock(() => ({
    info: mock(),
    warn: mock(),
    error: mock(),
  })),
}))();

void mock.module('@moonshot-ai/kap-server', () => {
  return {
    ...kapServerModule,
    startServer: mocks.startServer,
    createServerLogger: mocks.createServerLogger,
  };
});

void mock.module('@moonshot-ai/kimi-telemetry', () => ({
  track: mocks.track,
  shutdownTelemetry: mocks.shutdownTelemetry,
}));

void mock.module('#/cli/telemetry', () => ({
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
let stderrWritten: string[];
let foregroundIO: ForegroundIO;
let signalHandlers: Map<NodeJS.Signals, () => void>;

beforeEach(() => {
  exitCodes = [];
  stderrWritten = [];
  signalHandlers = new Map();
  // A real `process.exit` never returns; the shutdown path relies on that, so
  // record the code without unwinding (throwing here would surface as an
  // unhandled rejection from the runner's fire-and-forget `void shutdown()`).
  foregroundIO = {
    process: {
      once: (signal, listener) => {
        signalHandlers.set(signal, listener);
      },
      exit: (code?: number) => {
        exitCodes.push(Number(code ?? 0));
      },
    },
    stderr: {
      write(chunk: string | Uint8Array): boolean {
        stderrWritten.push(String(chunk));
        return true;
      },
    },
  };
  mocks.close.mockResolvedValue(undefined);
  mocks.shutdownTelemetry.mockResolvedValue(undefined);
  mocks.startServer.mockResolvedValue({
    host: '127.0.0.1',
    port: 4321,
    close: mocks.close,
  });
});

afterEach(() => {
  mock.restore();
  mock.clearAllMocks();
});

/**
 * Drive the real foreground runner to its shutdown path: the SIGINT listener is
 * registered once the server is "listening", so firing it is equivalent to the
 * user pressing Ctrl+C. `shutdown()` ends in the injected `exit`, which the fake
 * only records — the runner's own `void shutdown(...)` chain never settles, so
 * wait on the observed exit.
 */
async function runToShutdown(
  hooks: Parameters<typeof startServerForeground>[1] = {},
): Promise<void> {
  const pending = startServerForeground(parsedOptions, hooks, foregroundIO);
  pending.catch(() => {});
  await waitForAssertion(() => {
    expect(signalHandlers.has('SIGINT')).toBe(true);
  });
  signalHandlers.get('SIGINT')!();
  await waitForAssertion(() => {
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
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
  });

  it('exits 1 but still flushes telemetry when close fails', async () => {
    mocks.close.mockRejectedValue(new Error('cannot release the lock'));
    await runToShutdown();

    expect(exitCodes).toEqual([1]);
    expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
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
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
  });

  it('writes the failed step to stderr', async () => {
    mocks.close.mockRejectedValue(new Error('cannot release the lock'));

    await runToShutdown();

    expect(stderrWritten.join('')).toContain('close');
  });
});
