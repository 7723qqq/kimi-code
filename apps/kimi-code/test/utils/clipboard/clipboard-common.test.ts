import { describe, expect, it } from 'bun:test';

import {
  runCommandAsync,
  type CommandChild,
  type CommandSpawn,
  type CommandSpawnOptions,
} from '#/utils/clipboard/clipboard-common';
import { createFakeClock } from '#test/helpers/fake-clock';

interface FakeChild extends CommandChild {
  readonly killed: boolean;
  emitData(chunk: Buffer): void;
  emitError(): void;
  emitClose(code: number | null): void;
}

function createFakeChild(): FakeChild {
  let onData: ((chunk: Buffer) => void) | undefined;
  let onError: (() => void) | undefined;
  let onClose: ((code: number | null) => void) | undefined;
  let killed = false;

  const child = {
    onStdoutData: (listener: (chunk: Buffer) => void) => {
      onData = listener;
    },
    onError: (listener: () => void) => {
      onError = listener;
    },
    onClose: (listener: (code: number | null) => void) => {
      onClose = listener;
    },
    kill: () => {
      killed = true;
    },
    get killed(): boolean {
      return killed;
    },
    emitData: (chunk: Buffer) => {
      onData?.(chunk);
    },
    emitError: () => {
      onError?.();
    },
    emitClose: (code: number | null) => {
      onClose?.(code);
    },
  };
  return child;
}

describe('runCommandAsync', () => {
  it('resolves with the collected stdout for a zero exit', async () => {
    const child = createFakeChild();
    const spawn: CommandSpawn = () => child;
    const result = runCommandAsync('wl-paste', ['--list-types'], { spawn });

    child.emitData(Buffer.from('hello '));
    child.emitData(Buffer.from('world'));
    child.emitClose(0);

    const settled = await result;
    expect(settled.ok).toBe(true);
    expect(settled.stdout.toString('utf-8')).toBe('hello world');
  });

  it('resolves ok:false for a non-zero exit', async () => {
    const child = createFakeChild();
    const result = runCommandAsync('wl-paste', ['--list-types'], { spawn: () => child });
    child.emitClose(3);

    expect(await result).toEqual({ ok: false, stdout: Buffer.alloc(0) });
  });

  it('resolves ok:false when the child reports an error', async () => {
    const child = createFakeChild();
    const result = runCommandAsync('missing-helper', [], { spawn: () => child });
    child.emitError();

    expect((await result).ok).toBe(false);
  });

  it('passes the injected environment to the spawned child', async () => {
    const child = createFakeChild();
    let seen: CommandSpawnOptions | undefined;
    const spawn: CommandSpawn = (_command, _args, options) => {
      seen = options;
      return child;
    };

    const result = runCommandAsync('helper', [], { env: { PATH: '/opt/bin' }, spawn });
    child.emitClose(0);
    await result;

    expect(seen).toEqual({ env: { PATH: '/opt/bin' } });
  });

  it('resolves ok:false when spawning throws', async () => {
    const spawn: CommandSpawn = () => {
      throw new Error('ENOENT');
    };

    expect(await runCommandAsync('missing-helper', [], { spawn })).toEqual({
      ok: false,
      stdout: Buffer.alloc(0),
    });
  });

  it('kills the child and resolves ok:false once the injected timeout elapses', async () => {
    const clock = createFakeClock(1_000);
    const child = createFakeChild();
    const result = runCommandAsync('wedged-helper', [], {
      timeoutMs: 100,
      timers: clock,
      spawn: () => child,
    });
    expect(clock.activeTimers).toBe(1);

    expect(await Promise.race([result, Promise.resolve('pending' as const)])).toBe('pending');

    clock.advance(100);

    expect(child.killed).toBe(true);
    expect(await result).toEqual({ ok: false, stdout: Buffer.alloc(0) });
    expect(clock.activeTimers).toBe(0);
  });

  it('cancels the timeout once the child closes', async () => {
    const clock = createFakeClock();
    const child = createFakeChild();
    const result = runCommandAsync('helper', [], {
      timeoutMs: 500,
      timers: clock,
      spawn: () => child,
    });
    child.emitClose(0);

    expect((await result).ok).toBe(true);
    expect(clock.activeTimers).toBe(0);
    clock.advance(1_000);
    expect(child.killed).toBe(false);
  });
});
