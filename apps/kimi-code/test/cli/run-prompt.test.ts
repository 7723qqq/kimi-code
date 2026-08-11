/**
 * `kimi -p` print-mode entry and shared print-mode utilities.
 *
 * `runPrompt` now always dispatches to the native v2 runner
 * (`cli/v2/run-v2-print.ts`) — the agent-core-v2 engine is the only engine, so
 * there is no legacy `createKimiHarness` path left to exercise. This suite
 * covers the v2 dispatch and the shared utilities (`raceWithTimeout`,
 * `installPromptTerminationCleanup`, model resolution, signal exit codes).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { runPrompt } from '#/cli/run-prompt';
import {
  configuredModel,
  installPromptTerminationCleanup,
  requireConfiguredModel,
  signalExitCode,
  raceWithTimeout,
} from '#/cli/run-prompt';

const mocks = vi.hoisted(() => ({
  runV2Print: vi.fn(async () => {}),
}));

vi.mock('../../src/cli/v2/run-v2-print', () => ({
  runV2Print: mocks.runV2Print,
}));

function opts(overrides: Partial<Parameters<typeof runPrompt>[0]> = {}) {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'say hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  };
}

describe('runPrompt', () => {
  beforeEach(() => {
    mocks.runV2Print.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches to the native v2 runner with the CLI options', async () => {
    const cliOpts = opts({ prompt: 'ship it', model: 'kimi-code/k2.5' });

    await runPrompt(cliOpts, '1.2.3-test');

    expect(mocks.runV2Print).toHaveBeenCalledTimes(1);
    expect(mocks.runV2Print).toHaveBeenCalledWith(cliOpts, '1.2.3-test', {});
  });

  it('forwards the injected stdout/stderr/process io to the v2 runner', async () => {
    const stdout = { write: vi.fn(() => true) };
    const stderr = { write: vi.fn(() => true) };
    const processMock = {
      once: vi.fn(),
      off: vi.fn(),
      exit: vi.fn(),
    };

    await runPrompt(opts(), '1.2.3-test', { stdout, stderr, process: processMock });

    expect(mocks.runV2Print).toHaveBeenCalledWith(opts(), '1.2.3-test', {
      stdout,
      stderr,
      process: processMock,
    });
  });

  it('propagates v2 runner failures to the caller', async () => {
    mocks.runV2Print.mockRejectedValueOnce(new Error('provider error'));

    await expect(runPrompt(opts(), '1.2.3-test')).rejects.toThrow('provider error');
  });
});

describe('configuredModel / requireConfiguredModel', () => {
  it('picks the first non-empty model', () => {
    expect(configuredModel(undefined, '', 'k2')).toBe('k2');
    expect(configuredModel('kimi-code/k2.5', 'k2')).toBe('kimi-code/k2.5');
    expect(configuredModel()).toBeUndefined();
  });

  it('requireConfiguredModel throws with the friendly message when none is set', () => {
    expect(requireConfiguredModel('k2')).toBe('k2');
    expect(() => requireConfiguredModel(undefined, '')).toThrow('No model configured');
  });
});

describe('signalExitCode', () => {
  it('maps signals to 128+signum', () => {
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode('SIGHUP')).toBe(129);
    expect(signalExitCode('SIGQUIT')).toBe(143);
  });
});

describe('installPromptTerminationCleanup', () => {
  function fakeProcess() {
    const listeners = new Map<NodeJS.Signals, () => Promise<void> | void>();
    return {
      once: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: NodeJS.Signals, listener: () => Promise<void> | void) => {
        if (listeners.get(signal) === listener) {
          listeners.delete(signal);
        }
      }),
      exit: vi.fn(),
      listener: (signal: NodeJS.Signals) => listeners.get(signal),
    };
  }

  it('registers SIGINT/SIGTERM/SIGHUP handlers that clean up then exit', async () => {
    const processMock = fakeProcess();
    const cleanup = vi.fn(async () => {});

    installPromptTerminationCleanup(processMock, cleanup);

    expect(processMock.listener('SIGINT')).toBeDefined();
    expect(processMock.listener('SIGTERM')).toBeDefined();
    expect(processMock.listener('SIGHUP')).toBeDefined();

    await processMock.listener('SIGINT')?.();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(processMock.exit).toHaveBeenCalledWith(130);
  });

  it('deduplicates concurrent signals into one cleanup and exit', async () => {
    const processMock = fakeProcess();
    let releaseCleanup!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        }),
    );

    installPromptTerminationCleanup(processMock, cleanup);

    const first = processMock.listener('SIGINT')?.();
    const second = processMock.listener('SIGTERM')?.();
    await Promise.resolve();
    releaseCleanup();
    await Promise.all([first, second]);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(processMock.exit).toHaveBeenCalledWith(130);
  });

  it('removes the handlers when the returned disposer runs', () => {
    const processMock = fakeProcess();

    const dispose = installPromptTerminationCleanup(processMock, vi.fn());
    dispose();

    expect(processMock.listener('SIGINT')).toBeUndefined();
    expect(processMock.listener('SIGTERM')).toBeUndefined();
    expect(processMock.listener('SIGHUP')).toBeUndefined();
  });

  it('exits even when cleanup fails', async () => {
    const processMock = fakeProcess();

    installPromptTerminationCleanup(processMock, async () => {
      throw new Error('cleanup failed');
    });

    // The exit still runs in the finally block; the cleanup rejection
    // propagates to the (already-exiting) caller.
    await expect(processMock.listener('SIGTERM')?.()).rejects.toThrow('cleanup failed');
    expect(processMock.exit).toHaveBeenCalledWith(143);
  });
});

describe('raceWithTimeout', () => {
  it('propagates a fast rejection (cleanup failure must surface)', async () => {
    await expect(raceWithTimeout(Promise.reject(new Error('close failed')), 1000)).rejects.toThrow(
      'close failed',
    );
  });

  it('resolves when the timeout wins and swallows the late rejection', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const done = raceWithTimeout(
        new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('late rejection')), 2000);
          timer.unref?.();
        }),
        1000,
      ).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(settled).toBe(true);

      // The late rejection must not surface as an unhandled rejection.
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
