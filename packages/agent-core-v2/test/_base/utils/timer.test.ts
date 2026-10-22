import { describe, expect, it } from 'bun:test';

import { IntervalTimer, type IntervalScheduler } from '#/_base/utils/timer';

interface FakeIntervalScheduler extends IntervalScheduler {
  advance(byMs: number): void;
  readonly activeTimers: number;
}

interface ScheduledInterval {
  readonly id: number;
  readonly intervalMs: number;
  readonly callback: () => void;
  due: number;
}

function createFakeIntervalScheduler(): FakeIntervalScheduler {
  let nowMs = 0;
  let nextId = 1;
  const scheduled = new Map<number, ScheduledInterval>();
  return {
    setInterval: (callback, intervalMs) => {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { id, intervalMs, callback, due: nowMs + intervalMs });
      return { id };
    },
    clearInterval: (handle) => {
      scheduled.delete((handle as { id: number }).id);
    },
    advance: (byMs) => {
      const limit = nowMs + byMs;
      for (;;) {
        const next = [...scheduled.values()]
          .filter((interval) => interval.due <= limit)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0];
        if (next === undefined) break;
        nowMs = next.due;
        next.due += next.intervalMs;
        next.callback();
      }
      nowMs = limit;
    },
    get activeTimers() {
      return scheduled.size;
    },
  };
}

describe('IntervalTimer', () => {
  it('fires the runner repeatedly on the interval', () => {
    const scheduler = createFakeIntervalScheduler();
    const timer = new IntervalTimer({ scheduler });
    let count = 0;
    timer.cancelAndSet(() => {
      count += 1;
    }, 100);

    expect(timer.isSet()).toBe(true);
    scheduler.advance(250);
    expect(count).toBe(2);
    timer.dispose();
  });

  it('stops firing after cancel', () => {
    const scheduler = createFakeIntervalScheduler();
    const timer = new IntervalTimer({ scheduler });
    let count = 0;
    timer.cancelAndSet(() => {
      count += 1;
    }, 100);
    scheduler.advance(150);
    expect(count).toBe(1);

    timer.cancel();
    expect(timer.isSet()).toBe(false);
    expect(scheduler.activeTimers).toBe(0);
    scheduler.advance(200);
    expect(count).toBe(1);
  });

  it('cancelAndSet replaces a previously scheduled handle', () => {
    const scheduler = createFakeIntervalScheduler();
    const timer = new IntervalTimer({ scheduler });
    let a = 0;
    let b = 0;
    timer.cancelAndSet(() => {
      a += 1;
    }, 100);
    timer.cancelAndSet(() => {
      b += 1;
    }, 100);

    expect(scheduler.activeTimers).toBe(1);
    scheduler.advance(150);
    expect(a).toBe(0);
    expect(b).toBe(1);
    timer.dispose();
  });

  it('dispose is idempotent and stops the loop', () => {
    const scheduler = createFakeIntervalScheduler();
    const timer = new IntervalTimer({ scheduler });
    let count = 0;
    timer.cancelAndSet(() => {
      count += 1;
    }, 100);

    timer.dispose();
    timer.dispose();
    scheduler.advance(200);
    expect(count).toBe(0);
  });

  it('unrefs the scheduled handle only when unref is requested', () => {
    const unrefs: number[] = [];
    const handles: number[] = [];
    let nextId = 1;
    const recording: IntervalScheduler = {
      setInterval: () => {
        const id = nextId;
        nextId += 1;
        handles.push(id);
        return {
          unref: () => {
            unrefs.push(id);
          },
        };
      },
      clearInterval: () => {},
    };

    const plain = new IntervalTimer({ scheduler: recording });
    plain.cancelAndSet(() => {}, 100);
    expect(unrefs).toEqual([]);
    plain.dispose();

    const unrefTimer = new IntervalTimer({ scheduler: recording, unref: true });
    unrefTimer.cancelAndSet(() => {}, 100);
    expect(unrefs).toEqual([handles[1] as number]);
    unrefTimer.dispose();
  });

  it('cancel on a fresh timer is a no-op', () => {
    const scheduler = createFakeIntervalScheduler();
    const timer = new IntervalTimer({ scheduler });
    expect(() => timer.cancel()).not.toThrow();
    expect(timer.isSet()).toBe(false);
  });
});
