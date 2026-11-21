import { afterEach } from 'bun:test';
import { withGlobal, type Clock, type Config } from '@sinonjs/fake-timers';

export function createTestClock() {
  let clock: Clock | undefined;
  function current(): Clock {
    if (clock === undefined) throw new Error('Start the test clock before advancing it');
    return clock;
  }
  function stop(): void {
    clock?.uninstall();
    clock = undefined;
  }
  afterEach(stop);
  return {
    start(config: Config = {}): void {
      stop();
      clock = withGlobal(globalThis).install({
        now: Date.now(),
        toFake: [
          'Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
          'setImmediate', 'clearImmediate', 'performance',
          ...(typeof requestAnimationFrame === 'function' ? ['requestAnimationFrame', 'cancelAnimationFrame'] as const : []),
        ],
        ...config,
      });
    },
    stop,
    advance: (ms: number) => current().tick(ms),
    advanceAsync: (ms: number) => current().tickAsync(ms),
    setTime: (value: number | Date) => current().setSystemTime(value),
    count: () => current().countTimers(),
    clear: () => current().reset(),
    get active() { return clock !== undefined; },
  };
}
