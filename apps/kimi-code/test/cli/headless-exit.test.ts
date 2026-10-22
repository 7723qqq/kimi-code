import { describe, expect, it, mock } from 'bun:test';
import type { Writable } from 'node:stream';

import { createFakeClock } from '#test/helpers/fake-clock';

import { drainStdio, finalizeHeadlessRun, scheduleHeadlessForceExit } from '#/cli/headless-exit';
import type { RenderClock, RenderTimerHandle } from '#/tui/utils/render-clock';

interface TestClock {
  readonly clock: RenderClock;
  advance(byMs: number): void;
}

/**
 * A fake clock for the force-exit seam.
 *
 * `createFakeClock` models `unref()` as cancellation — right for render timers,
 * whose unref merely lets the process exit. The headless backstop is the
 * opposite: it MUST fire, it only must not hold the event loop open. This
 * adapter keeps handle identity for `clearTimeout` (so cancellation is still
 * observable) while leaving `unref()` inert. The real unref behaviour is
 * pinned separately against the default clock, where `hasRef()` is available.
 */
function createTestClock(startMs = 0): TestClock {
  const inner = createFakeClock(startMs);
  const handles = new Map<RenderTimerHandle, RenderTimerHandle>();
  const track = (schedule: () => RenderTimerHandle): RenderTimerHandle => {
    const handle: RenderTimerHandle = {};
    handles.set(handle, schedule());
    return handle;
  };
  const untrack = (handle: RenderTimerHandle, cancel: (inner: RenderTimerHandle) => void): void => {
    const target = handles.get(handle);
    if (target !== undefined) cancel(target);
  };
  return {
    clock: {
      now: () => inner.now(),
      setTimeout: (callback, delayMs) => track(() => inner.setTimeout(callback, delayMs)),
      clearTimeout: (handle) => untrack(handle, (target) => inner.clearTimeout(target)),
      setInterval: (callback, intervalMs) => track(() => inner.setInterval(callback, intervalMs)),
      clearInterval: (handle) => untrack(handle, (target) => inner.clearInterval(target)),
    },
    advance: (byMs) => inner.advance(byMs),
  };
}

/** Let the promise chains behind a settled clock tick run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

async function advanceAsync(clock: TestClock, byMs: number): Promise<void> {
  await settle();
  clock.advance(byMs);
  await settle();
}

describe('scheduleHeadlessForceExit', () => {
  it('force-exits with the lazily-resolved exit code after the grace period', () => {
    const clock = createTestClock();
    const exit = mock();
    let code = 0;
    scheduleHeadlessForceExit({ exit }, () => code, 2000, clock.clock);
    // The exit code can be set after scheduling (e.g. a goal turn maps its
    // terminal status to process.exitCode); it must be read at fire time.
    code = 7;

    expect(exit).not.toHaveBeenCalled();
    clock.advance(1999);
    expect(exit).not.toHaveBeenCalled();
    clock.advance(1);
    expect(exit).toHaveBeenCalledWith(7);
  });

  it('schedules an unref\'d timer so a healthy run still exits naturally', () => {
    // Real timers: an un-unref'd guard would itself keep the event loop alive,
    // turning the fix into a regression (every healthy run would wait the full
    // grace before exiting). hasRef() must be false.
    const exit = mock();
    const handle = scheduleHeadlessForceExit({ exit }, () => 0, 60_000);
    expect((handle as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    clearTimeout(handle as unknown as NodeJS.Timeout);
  });

  it('does not fire once cancelled via clearTimeout', () => {
    const clock = createTestClock();
    const exit = mock();
    const handle = scheduleHeadlessForceExit({ exit }, () => 0, 2000, clock.clock);
    clock.clock.clearTimeout(handle);
    clock.advance(5000);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('drainStdio', () => {
  it('resolves once buffered output has flushed', async () => {
    let flush: (() => void) | undefined;
    const stream = {
      write: mock((_chunk: string, cb: () => void) => {
        flush = cb;
        return false;
      }),
    } as unknown as Writable;

    let resolved = false;
    const done = drainStdio([stream], 5000).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // still draining

    flush?.(); // consumer caught up
    await done;
    expect(resolved).toBe(true);
  });

  it('gives up after the timeout when the consumer never drains', async () => {
    const clock = createTestClock();
    // write() never invokes its flush callback — a permanently-stuck consumer.
    const stream = { write: mock(() => false) } as unknown as Writable;

    let resolved = false;
    const done = drainStdio([stream], 3000, clock.clock).then(() => {
      resolved = true;
    });
    // This pins the exact 2999/3000 boundary, so the clock is stepped in one
    // window at a time around it.
    await advanceAsync(clock, 2999);
    expect(resolved).toBe(false);
    await advanceAsync(clock, 1);
    await done;
    expect(resolved).toBe(true);
  });
});

describe('finalizeHeadlessRun', () => {
  it('flushes stdio before arming the force-exit so buffered output is not truncated', async () => {
    const clock = createTestClock();
    let flush: (() => void) | undefined;
    const stream = {
      write: mock((_chunk: string, cb: () => void) => {
        flush = cb;
        return false;
      }),
    } as unknown as Writable;
    const exit = mock();

    const done = finalizeHeadlessRun({ exit }, [stream], () => 0, {
      drainTimeoutMs: 5000,
      graceMs: 2000,
      clock: clock.clock,
    });

    // Output is still draining: even well past the force-exit grace, we must NOT
    // have armed/fired the exit — doing so would truncate the buffered output.
    await advanceAsync(clock, 4000);
    expect(exit).not.toHaveBeenCalled();

    // Consumer catches up → drain completes → only now is the backstop armed.
    flush?.();
    await done;
    expect(exit).not.toHaveBeenCalled();
    await advanceAsync(clock, 2000);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
