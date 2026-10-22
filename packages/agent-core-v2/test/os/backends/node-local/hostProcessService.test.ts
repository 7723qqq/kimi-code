import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import * as childProcess from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { expectRejection } from '#test/helpers/assertions';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';
import type { IHostTimerHandle, IHostTimers } from '#/os/interface/hostTimers';

interface FakeTimerHandle extends IHostTimerHandle {
  readonly id: number;
}

interface FakeTimers extends IHostTimers {
  advance(byMs: number): void;
  readonly pending: number;
}

function createFakeTimers(): FakeTimers {
  let nowMs = 0;
  let nextId = 1;
  const scheduled: Array<{
    readonly id: number;
    readonly due: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  const schedule = (callback: () => void, timeoutMs: number): FakeTimerHandle => {
    const timer = { id: nextId, due: nowMs + timeoutMs, callback, cancelled: false };
    nextId += 1;
    scheduled.push(timer);
    return { id: timer.id, unref: () => {} };
  };

  return {
    _serviceBrand: undefined,
    setClampedTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    setTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    clearTimeout: (handle) => {
      const id = (handle as FakeTimerHandle).id;
      const timer = scheduled.find((candidate) => candidate.id === id);
      if (timer !== undefined) timer.cancelled = true;
    },
    advance: (byMs) => {
      const limit = nowMs + byMs;
      for (;;) {
        const next = scheduled
          .filter((timer) => !timer.cancelled && timer.due <= limit)
          .toSorted((a, b) => a.due - b.due || a.id - b.id)[0];
        if (next === undefined) break;
        next.cancelled = true;
        nowMs = next.due;
        next.callback();
      }
      nowMs = limit;
    },
    get pending() {
      return scheduled.filter((timer) => !timer.cancelled).length;
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('HostProcessService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('terminates a process that outlives its timeout', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeout: 200 });
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });

  it('spawns a process and captures stdout + exit code', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('passes env overrides to the child', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.FOO ?? "")'], {
      env: { FOO: 'bar' },
    });
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('throws a coded error when the command does not exist', async () => {
    const svc = ix.get(IHostProcessService);
    await expectRejection(svc.spawn('definitely-not-a-real-command-42'), (err: unknown) => {
        expect(err).toBeInstanceOf(HostProcessError);
        const error = err as HostProcessError;
        expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
        expect(error.code).toBe('os.process.spawn_failed');
        expect(error.details).toMatchObject({
          command: 'definitely-not-a-real-command-42',
          errno: 'ENOENT',
        });
        expect(error.cause).toBeInstanceOf(Error);
        return true;
      });
  });

  it('terminates a running process with kill()', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await proc.kill('SIGTERM');
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });
});

describe.skipIf(process.platform !== 'win32')('HostProcessService (Windows)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let tempDir: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
    tempDir = mkdtempSync(join(tmpdir(), 'kimi-hostproc-'));
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs extensionless .cmd shims found via PATHEXT through cmd.exe', async () => {
    writeFileSync(join(tempDir, 'fakecmd.cmd'), '@echo fake-ok\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('fakecmd', [], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out.trim()).toBe('fake-ok');
    expect(await proc.wait()).toBe(0);
  });

  it('preserves argument boundaries through the cmd.exe wrapper', async () => {
    writeFileSync(join(tempDir, 'argcmd.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('argcmd', ['hello world', 'x"y'], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out).toContain('["hello world"]');
    expect(out).toContain('["x""y"]');
    expect(await proc.wait()).toBe(0);
  });

  it('preserves a trailing backslash inside a quoted argument', async () => {
    writeFileSync(join(tempDir, 'argcmd.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('argcmd', ['C:\\Program Files\\', 'plain'], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out).toContain('["C:\\Program Files\\\\"]');
    expect(await proc.wait()).toBe(0);
  });

  it('preserves a quote followed by a trailing backslash', async () => {
    writeFileSync(join(tempDir, 'argcmd.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('argcmd', ['a"b\\', 'plain'], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out).toContain('["a""b\\\\"]');
    expect(await proc.wait()).toBe(0);
  });

  it('runs an explicitly named .cmd file through cmd.exe', async () => {
    writeFileSync(join(tempDir, 'explicit.cmd'), '@echo explicit-ok\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn(join(tempDir, 'explicit.cmd'), []);
    const out = await collect(proc.stdout);
    expect(out.trim()).toBe('explicit-ok');
    expect(await proc.wait()).toBe(0);
  });
});

describe('HostProcessService on Windows', () => {
  let savedPlatform: string;
  let spawnedCommands: string[];
  let taskkills: Array<{ kill: ReturnType<typeof mock>; unref: ReturnType<typeof mock> }>;

  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    savedPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnedCommands = [];
    taskkills = [];
    spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: readonly string[]) => {
      spawnedCommands.push([command, ...args].join(' '));
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: mock(() => true),
        unref: mock(),
      });
      if (command === 'taskkill') taskkills.push(child);
      else queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never);
  });

  afterEach(() => {
    spawnSpy?.mockRestore();
    spawnSpy = undefined;
    Object.defineProperty(process, 'platform', { value: savedPlatform });
  });

  it('stops waiting for a taskkill that never exits and terminates it', async () => {
    const { HostProcessService: WindowsHostProcessService } = await import(
      '#/os/backends/host/hostProcessService'
    );
    const timers = createFakeTimers();
    const proc = await new WindowsHostProcessService(timers).spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    let killed = false;
    const kill = proc.kill('SIGTERM').then(() => {
      killed = true;
    });

    await flushAsyncWork();
    expect(timers.pending).toBe(1);
    timers.advance(5_000);
    await flushAsyncWork();

    expect(spawnedCommands).toContain('taskkill /T /F /PID 4242');
    expect(killed).toBe(true);
    expect(taskkills).toHaveLength(1);
    expect(taskkills[0]?.kill).toHaveBeenCalled();
    expect(taskkills[0]?.unref).toHaveBeenCalled();
    await kill;
  });
});
