import type { Clock, TimerHandle } from '../../src/lib/clock';

interface ScheduledTimer {
  due: number;
  readonly callback: () => void;
  readonly intervalMs: number | undefined;
  cancelled: boolean;
}

export interface FakeClock extends Clock {
  advance(byMs: number): void;
  advanceAsync(byMs: number): Promise<void>;
  readonly activeTimers: number;
}

const realSetImmediate = setImmediate;

export function createFakeClock(startMs = Date.now()): FakeClock {
  let nowMs = startMs;
  const timers: ScheduledTimer[] = [];
  const handles = new Map<TimerHandle, ScheduledTimer>();

  const schedule = (callback: () => void, delayMs: number, intervalMs?: number): TimerHandle => {
    const timer: ScheduledTimer = {
      due: nowMs + delayMs,
      callback,
      intervalMs,
      cancelled: false,
    };
    timers.push(timer);
    const handle: TimerHandle = { unref: () => {} };
    handles.set(handle, timer);
    return handle;
  };

  const cancel = (handle: TimerHandle): void => {
    const timer = handles.get(handle);
    if (timer !== undefined) timer.cancelled = true;
    handles.delete(handle);
  };

  const nextDue = (limit: number): ScheduledTimer | undefined => {
    let next: ScheduledTimer | undefined;
    for (const timer of timers) {
      if (timer.cancelled || timer.due > limit) continue;
      if (next === undefined || timer.due < next.due) next = timer;
    }
    return next;
  };

  const prune = (): void => {
    for (let index = timers.length - 1; index >= 0; index -= 1) {
      if (timers[index]?.cancelled === true) timers.splice(index, 1);
    }
  };

  const advance = (byMs: number): void => {
    const limit = nowMs + byMs;
    let guard = 0;
    for (;;) {
      const timer = nextDue(limit);
      if (timer === undefined) break;
      guard += 1;
      if (guard > 100_000) throw new Error('fake clock advanced more than 100000 timers');
      nowMs = timer.due;
      if (timer.intervalMs === undefined) timer.cancelled = true;
      else timer.due += timer.intervalMs;
      timer.callback();
    }
    nowMs = limit;
    prune();
  };

  return {
    now: () => nowMs,
    setTimeout: (callback, delayMs) => schedule(callback, delayMs),
    clearTimeout: cancel,
    setInterval: (callback, intervalMs) => schedule(callback, intervalMs, intervalMs),
    clearInterval: cancel,
    advance,
    advanceAsync: async (byMs) => {
      advance(byMs);
      for (let round = 0; round < 4; round += 1) {
        await Promise.resolve();
        await new Promise<void>((resolve) => {
          realSetImmediate(resolve);
        });
      }
    },
    get activeTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}
