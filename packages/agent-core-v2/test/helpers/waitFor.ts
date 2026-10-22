const realSetTimeout = setTimeout;

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
