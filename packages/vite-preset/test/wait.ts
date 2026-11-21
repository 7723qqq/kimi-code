import { until } from '@moonshot-ai/testkit/fixtures';
import type { createTestClock } from './clock';

interface WaitOptions {
  timeout?: number;
  interval?: number;
}

export async function waitForAssertion<T>(
  check: () => T | Promise<T>,
  options: WaitOptions | number = {},
  clock?: ReturnType<typeof createTestClock>,
): Promise<T> {
  const { timeout = 1000, interval = 50 } = typeof options === 'number' ? { timeout: options } : options;
  if (!clock?.active) {
    const result = await until('renderer assertion', async () => ({ value: await check() }), { timeoutMs: timeout, intervalMs: interval });
    return result.value;
  }
  for (let elapsed = 0; ; ) {
    try {
      return await check();
    } catch (error) {
      if (elapsed >= timeout) throw error;
      const step = Math.min(interval, timeout - elapsed);
      await clock.advanceAsync(step);
      elapsed += step;
    }
  }
}
