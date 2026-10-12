import type * as NodeChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `LocalProcess.kill()` on Windows terminates the tree with `taskkill /T /F`.
// It used to await that child without a deadline, so a taskkill that never
// reports back (hung tree, deep descendants) hung the caller forever. These
// cases drive the win32 branch through a mocked `node:child_process`; on
// Windows itself the platform is already right, elsewhere it is patched
// *before* `#/local` is imported, because `isWindows` is captured at module
// load.
const onWindows = process.platform === 'win32';

const TASKKILL_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      throw new Error(`timed out after ${timeoutMs}ms`);
    })(),
  ]);
}

describe('LocalProcess.kill() taskkill deadline (win32 branch)', () => {
  let savedPlatform: string | undefined;
  let taskkills: Array<
    EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
  >;
  let spawnedCommands: string[];

  beforeEach(() => {
    if (!onWindows) {
      savedPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    }
    taskkills = [];
    spawnedCommands = [];
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof NodeChildProcess>()),
      spawn: (command: string, args: readonly string[]) => {
        spawnedCommands.push([command, ...args].join(' '));
        const child = Object.assign(new EventEmitter(), {
          pid: 4242,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: vi.fn(() => true),
          unref: vi.fn(),
        });
        if (command === 'taskkill') {
          // Never emits `close` or `error` unless a test makes it.
          taskkills.push(child);
        } else {
          queueMicrotask(() => child.emit('spawn'));
        }
        return child;
      },
    }));
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('node:child_process');
    vi.resetModules();
    if (savedPlatform !== undefined) {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
      savedPlatform = undefined;
    }
  });

  async function startProcess(): Promise<{ kill: () => Promise<void> }> {
    const { LocalKaos } = await import('#/local');
    // Bypass `create()` (it probes os/shell) — only `_cwd` and `_envLayers`
    // are read by `exec()`. The constructor is private, so the instance is
    // built from the prototype.
    const kaos = Object.create(LocalKaos.prototype) as {
      _cwd: string;
      _envLayers: readonly Record<string, string>[];
      exec(...args: string[]): Promise<{ kill(signal?: NodeJS.Signals): Promise<void> }>;
    };
    kaos._cwd = '/';
    kaos._envLayers = [];
    const proc = await kaos.exec('node', '-e', 'setTimeout(() => {}, 30000)');
    return { kill: () => proc.kill('SIGTERM') };
  }

  it('stops waiting for a taskkill that never exits and terminates it', async () => {
    const { kill } = await startProcess();
    vi.useFakeTimers();

    let resolved = false;
    const killed = kill().then(() => {
      resolved = true;
      return undefined;
    });

    await vi.advanceTimersByTimeAsync(TASKKILL_TIMEOUT_MS);

    expect(spawnedCommands).toContain('taskkill /T /F /PID 4242');
    expect(resolved).toBe(true);
    expect(taskkills).toHaveLength(1);
    expect(taskkills[0]?.kill).toHaveBeenCalled();
    expect(taskkills[0]?.unref).toHaveBeenCalled();
    await killed;
  });

  it('resolves as soon as taskkill exits, without waiting for the deadline', async () => {
    const { kill } = await startProcess();

    const killed = kill();
    taskkills[0]?.emit('close');

    await expect(withTimeout(killed, 1_000)).resolves.toBeUndefined();
    expect(taskkills[0]?.kill).not.toHaveBeenCalled();
  });
});
