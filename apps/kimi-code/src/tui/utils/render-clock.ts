export interface RenderTimerHandle {
  unref?(): void;
}

export interface RenderClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): RenderTimerHandle;
  clearTimeout(handle: RenderTimerHandle): void;
  setInterval(callback: () => void, intervalMs: number): RenderTimerHandle;
  clearInterval(handle: RenderTimerHandle): void;
}

export const SYSTEM_RENDER_CLOCK: RenderClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};
