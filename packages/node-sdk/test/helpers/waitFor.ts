export interface PollOptions {
  readonly timeout?: number;
  readonly interval?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

const DEFAULT_INTERVAL_MS = 10;

export async function waitForAssertion(
  assertion: () => void | Promise<void>,
  options: PollOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeout;
  let failure: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline) throw failure;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export async function waitUntil<T>(
  probe: () => T | Promise<T>,
  options: PollOptions & { readonly until?: (value: T) => boolean } = {},
): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? DEFAULT_INTERVAL_MS;
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
