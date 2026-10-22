import type { RenderClock, RenderTimerHandle } from '#/tui/utils/render-clock';

interface ScheduledTimer {
  due: number;
  readonly callback: () => void;
  readonly intervalMs: number | undefined;
  cancelled: boolean;
}

export interface FakeClock extends RenderClock {
  set(nowMs: number): void;
  advance(byMs: number): void;
  readonly activeTimers: number;
}

export function createFakeClock(startMs = 0): FakeClock {
  let nowMs = startMs;
  const timers: ScheduledTimer[] = [];

  const schedule = (callback: () => void, delayMs: number, intervalMs?: number): RenderTimerHandle => {
    const timer: ScheduledTimer = {
      due: nowMs + delayMs,
      callback,
      intervalMs,
      cancelled: false,
    };
    timers.push(timer);
    const handle: RenderTimerHandle = {
      unref: () => {
        timer.cancelled = true;
      },
    };
    return handle;
  };

  const cancel = (handle: RenderTimerHandle): void => {
    handle.unref?.();
  };

  const nextDue = (limit: number): ScheduledTimer | undefined => {
    let next: ScheduledTimer | undefined;
    for (const timer of timers) {
      if (timer.cancelled || timer.due > limit) continue;
      if (next === undefined || timer.due < next.due) next = timer;
    }
    return next;
  };

  const clock: FakeClock = {
    now: () => nowMs,
    setTimeout: (callback, delayMs) => schedule(callback, delayMs),
    clearTimeout: cancel,
    setInterval: (callback, intervalMs) => schedule(callback, intervalMs, intervalMs),
    clearInterval: cancel,
    set: (value) => {
      nowMs = value;
    },
    advance: (byMs) => {
      const limit = nowMs + byMs;
      let guard = 0;
      for (;;) {
        const timer = nextDue(limit);
        if (timer === undefined) break;
        guard += 1;
        if (guard > 100_000) throw new Error('fake clock advanced more than 100000 timers');
        nowMs = timer.due;
        if (timer.intervalMs === undefined) {
          timer.cancelled = true;
        } else {
          timer.due += timer.intervalMs;
        }
        timer.callback();
      }
      nowMs = limit;
      for (let index = timers.length - 1; index >= 0; index -= 1) {
        if (timers[index]?.cancelled === true) timers.splice(index, 1);
      }
    },
    get activeTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
  return clock;
}
