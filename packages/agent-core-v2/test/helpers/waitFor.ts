const realSetTimeout = setTimeout;

export async function advanceTimersByTimeAsync(
  advance: (ms: number) => void | Promise<void>,
  ms: number,
): Promise<void> {
  await advance(ms);
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

export async function advanceUntilNoTimersRemain(
  advance: (ms: number) => void | Promise<void>,
  ms: number,
  pending: () => number,
): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    await advanceTimersByTimeAsync(advance, ms);
    if (pending() === 0) return;
  }
}

export interface PollOptions {
  readonly timeout?: number;
  readonly interval?: number;
}

export async function waitUntil<T>(
  probe: () => T | Promise<T>,
  options: PollOptions & { readonly until?: (value: T) => boolean } = {},
): Promise<T> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const until = options.until ?? ((value: T) => Boolean(value));
  const deadline = performance.now() + timeout;
  let lastError: unknown;
  let last: T | undefined;
  for (;;) {
    try {
      last = await probe();
      if (until(last)) return last;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) {
      if (lastError instanceof Error) throw lastError;
      throw new Error(`waitUntil timed out after ${timeout}ms (last value: ${String(last)})`);
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, interval);
    });
  }
}

export async function waitForAssertion(probe: () => unknown, options: PollOptions = {}): Promise<void> {
  await waitUntil(probe, { ...options, until: () => true });
}
