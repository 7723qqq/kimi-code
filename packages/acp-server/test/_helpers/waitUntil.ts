export interface WaitUntilOptions<T> {
  readonly timeout?: number;
  readonly interval?: number;
  readonly until?: (value: T) => boolean;
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === 'string') return thrown;
  return Object.prototype.toString.call(thrown);
}

export async function waitUntil<T>(
  probe: () => T | Promise<T>,
  opts: WaitUntilOptions<T> = {},
): Promise<T> {
  const timeout = opts.timeout ?? 5_000;
  const interval = opts.interval ?? 10;
  const until = opts.until ?? ((value: T) => Boolean(value));
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  let lastError: unknown;
  for (;;) {
    try {
      last = await probe();
      lastError = undefined;
      if (until(last)) return last;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      if (lastError !== undefined) {
        throw new Error(
          `waitUntil timed out after ${timeout}ms: ${describeThrown(lastError)}`,
        );
      }
      throw new Error(`waitUntil timed out after ${timeout}ms (last value: ${String(last)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
