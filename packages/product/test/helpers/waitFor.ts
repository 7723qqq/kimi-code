const realSetTimeout = setTimeout;

export interface PollOptions {
  readonly timeout?: number;
  readonly interval?: number;
}

export async function waitForAssertion(
  probe: () => unknown,
  options: PollOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const deadline = performance.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      probe();
      return;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) {
      if (lastError instanceof Error) throw lastError;
      throw new Error(`waitForAssertion timed out after ${timeout}ms`);
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, interval);
    });
  }
}

export async function waitUntil<T>(
  probe: () => T | Promise<T>,
  options: PollOptions & { readonly until?: (value: T) => boolean } = {},
): Promise<T> {
  const timeout = options.timeout ?? 2_000;
  const interval = options.interval ?? 10;
  const until = options.until ?? ((value: T) => Boolean(value));
  const deadline = Date.now() + timeout;
  let last: unknown;
  let lastError: unknown;
  let observed = false;
  for (;;) {
    try {
      const value = await probe();
      if (until(value)) return value;
      last = value;
      observed = true;
      lastError = undefined;
    } catch (error) {
      lastError = error;
      observed = false;
    }
    if (Date.now() >= deadline) {
      if (observed) {
        throw new Error(`waitUntil timed out after ${timeout}ms with ${String(last)}`);
      }
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
