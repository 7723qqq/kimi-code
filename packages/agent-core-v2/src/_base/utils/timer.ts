import type { IDisposable } from '#/_base/di/lifecycle';

export const MAX_TIMER_DELAY_MS = 0x7fffffff;

export function setClampedTimeout(
  callback: () => void,
  timeoutMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, Math.min(timeoutMs, MAX_TIMER_DELAY_MS));
}

export interface IntervalScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export const SYSTEM_INTERVAL_SCHEDULER: IntervalScheduler = {
  setInterval(callback, intervalMs) {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface IntervalTimerOptions {
  readonly unref?: boolean;
  readonly scheduler?: IntervalScheduler;
}

export class IntervalTimer implements IDisposable {
  private handle: unknown;
  private readonly scheduler: IntervalScheduler;

  constructor(private readonly options: IntervalTimerOptions = {}) {
    this.scheduler = options.scheduler ?? SYSTEM_INTERVAL_SCHEDULER;
  }

  cancel(): void {
    if (this.handle !== undefined) {
      this.scheduler.clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  cancelAndSet(runner: () => void, intervalMs: number): void {
    this.cancel();
    const handle = this.scheduler.setInterval(runner, intervalMs);
    if (
      this.options.unref === true &&
      typeof handle === 'object' &&
      handle !== null &&
      'unref' in handle
    ) {
      (handle as { unref: () => void }).unref();
    }
    this.handle = handle;
  }

  isSet(): boolean {
    return this.handle !== undefined;
  }

  dispose(): void {
    this.cancel();
  }
}

export class TimeoutTimer implements IDisposable {
  private handle: ReturnType<typeof setTimeout> | undefined;

  cancel(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  cancelAndSet(runner: () => void, timeoutMs: number): void {
    this.cancel();
    const handle = setTimeout(() => {
      this.handle = undefined;
      runner();
    }, timeoutMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      (handle as { unref: () => void }).unref();
    }
    this.handle = handle;
  }

  dispose(): void {
    this.cancel();
  }
}
